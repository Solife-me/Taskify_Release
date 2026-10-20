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
| 3 | PWA boards, tasks, Upcoming, calendar, desktop layout | `ui/board`, `ui/task`, `domains/tasks`, `domains/calendar`, `styles/desktop-layout.css` | Done (2026-10-18); one follow-up (event attachments) |
| 4 | PWA sync and storage | `nostr/`, `storage/`, `domains/nostr` | Done (2026-10-19) |
| 5 | PWA chat, contacts, sharing, agent mode, voice, Bible tracker | `chat/`, `lib/`, `components/` (agent mode was removed earlier) | Done (2026-10-19) |
| 6 | PWA wallet phase-out | `wallet/`, `mint/`, `context/Cashu*` — what can be deleted or lazy-loaded | Done (2026-10-19); code deletion due after Dec 1, 2026 |
| 7 | iOS TaskifyCore | Swift sync, state and Nostr engine | Done (2026-10-20) |
| 8 | iOS tasks, boards, Upcoming UI | `TaskifyApp/Features` (tasks side) | Reviewed 2026-10-20, awaiting decisions |
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
| C2-3 | Approve all stages | 2026-10-15 | Stages 1–4 done (2026-10-18): Chat is independent and fully type-checked, the Cashu modal is wallet-only, and Upcoming, Chat, Bible, Print, scan and Voice load lazily. Live two-account messaging verification remains outstanding |
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
   layout; the mobile layout is good").** Details under "Desktop layout" below. Pass 1 done;
   pass 2 is next.
3. **Board page out of `App` (done 2026-10-17).** Task and event card behaviour is provided once
   through `ui/task/taskActions.tsx`: a stable actions object (each method calls `App`'s latest
   handler, so its identity never changes) plus a view-state context (selection, sync, display
   settings). `BoardTaskCard`, `BoardEventCard` and the Upcoming card components replace five
   hand-wired copies of the card props. The board body is `ui/board/BoardPage.tsx` with
   `WeekBoardView`, `ListsBoardView` and `BibleBoardView` (the Bible view was written out twice).
   `App.tsx` 8,777 → 8,374 lines. Boards is not lazy: it is the startup page.
4. **The rest of stage 4 (done 2026-10-18):** Bible, Print, Import (scan) and Voice load lazily.
   - The Bible tracker's data model (books, stored state, clean-up) moved out of the component
     into `domains/scripture/bibleTrackerModel.ts`, so the domain code and backups no longer
     pull in the tracker UI. The Bible board view (tracker and scripture memory) loads only when
     a Bible board is shown.
   - Voice dictation loads when Dictate is chosen.
   - Print and scan sheets moved out of `AppModalStack` into `ui/print/PrintSheets.tsx`, which
     loads only when one opens. The camera QR scanner in Add board loads with its scan section.
     The modal stack opens for common things (the delete-undo snackbar, onboarding); it was
     26.4 KB gzipped with the QR tools and is now 4.7 KB.
   - Fixed while testing: Print (and Print selected) from the Share sheet closed at once. Closing
     one sheet and opening another in the same action stepped history back over both. The router
     now lets the new overlay take the closed one's entry, and overlays close in the layout phase
     so that always happens before an open. Two tests cover it.
   - `scripts/startup-budget.mjs` now fails if Upcoming, Chat, the Bible board, voice
     dictation, print sheets or the wallet runtime become part of startup, or if the modal stack
     carries the QR tools. Startup JavaScript 450.8 → 441.0 KB gzipped; the budget is lowered
     from 470 to 455 KB.
5. **Chunk 3 onward,** per the chunk plan.

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
- **Order (revised 2026-10-17).** Moving the board page out of `App` turned out not to be
  needed for the maintainer's two main asks (the rail and sideways scrolling), and lazy-loading
  Boards gains nothing because it is the startup page. Doing it properly first needs the task
  actions (complete, move, edit, inline add, selection, drag and drop) behind a shared context.
  That refactor is still planned, after C3-1; C3-1 went first.
- **Pass 1 (done 2026-10-17):**
  - The rail is one glass panel in the mobile tab bar's material: the four pages (compact),
    then the user's boards (`ui/layout/RailBoardList.tsx`). One click opens a board from any
    page; dropping a dragged task on a board moves it there; "+" adds a board.
  - On desktop the header names the board (with its share button) instead of showing the board
    dropdown, which the rail replaces.
  - Sideways scrolling with a mouse (`ui/board/useBoardScrollAssist.ts`, `BoardScrollEdges`):
    - the wheel scrolls the board sideways except over a list long enough to scroll itself;
    - dragging empty board space pans;
    - edge buttons appear while lists are hidden off either side.
    Touch screens and trackpad sideways swipes are untouched.
  - The shell is no longer capped at 80rem, so wide screens show more lists side by side.
    (Pass 1 also let week columns shrink to fit seven days; that was reverted at the
    maintainer's request so lists stay 325 px everywhere.)
  - Settings is a readable centered column (52rem); Upcoming's list stays centered.
  - Mobile is unchanged (checked at 375×812).
- **Pass 2 (done 2026-10-17):**
  - Task, event and note editors dock as a pane on the right, so the board stays in view.
    `Modal` takes `desktop="pane" | "dialog"`; phones keep the full-height sheet.
  - Add board is a centered dialog sized to its content. Action sheets (sort, filter) float in
    the middle instead of rising from the bottom edge.
  - Escape closes the top-most dialog, sheet or pane, one per press. In a text field, the first
    Escape only leaves the field (`ui/useEscapeToClose.ts`, tested). It replaces two separate
    Escape listeners that could fire together.
  - ← and → move the board one list at a time when no field or dialog has focus.
  - Upcoming's day-by-day view shows the month calendar beside the list; clicking a day jumps
    the list there.
  - Chat no longer covers the rail: on desktop the wallet/chat overlay covers only the content
    column, and Chat keeps a readable width.
  - Card density: not changed, per the rule that lists and cards keep their mobile size; cards
    only gain a hover state.
- **Two-pane Chat (done 2026-10-17):** on desktop the conversation list stays on the left and
  the open conversation, new message or group screens fill the right, with the open
  conversation highlighted and a placeholder when none is open. The rail stays visible inside a
  conversation (phones still hide the tab bar there). The overlay uses `overflow: clip`, because
  `hidden` let a conversation's `scrollIntoView` shift the overlay sideways.
- **Chat independence (maintainer decision 2026-10-17, in progress).** "The wallet is phasing out
  so the chat functions need to be totally independent so that the wallet can be turned off when
  ready. When a cashu token is received in chat it should be copyable but beyond that needs no
  wallet functions."
  - **Done (checkpoint commit "Give chat its own module, independent of the wallet"):**
    - `src/chat/` exists. Chat's hooks moved there from `hooks/wallet` (`src/chat/hooks/`:
      DM state/subscription/send/thread hooks, contacts state/sync/lookup/detail, group and
      scanned-contact derivations). They are still `@ts-nocheck`, as before.
    - Lint rule (eslint.config.js): nothing in `src/chat/**` may import wallet, mint or Cashu
      code. The wallet may import chat, not the reverse.
    - `chat/chatHelpers.tsx` (type-checked) and `chat/chatUi.tsx` hold the chat helpers and UI
      pieces; `wallet/walletModalHelpers.tsx` and `ui/wallet/walletModalUi.tsx` keep wallet-only
      code and re-export chat's. `QrCodeCard` takes its animation as a prop; the wallet's
      wrapper passes NUT-16.
    - `chat/hooks/useNostrSession.ts`: the relay pool, identity, publishing and DM decryption,
      split out of the wallet's `useNostrPoolState`, which now builds on it.
    - `chat/cashuTokenText.ts` (tested): finds a Cashu token in a message by its shape, without
      the Cashu library. `useDmState` and `useDmSubscription` use it; tokens get no amount.
    - Wallet-only parameters removed or made optional in chat hooks (`useContactDetail` lost the
      pay actions, `useContactsSync` an unused lightning-address argument, `useContactsState`
      the wallet-tab arguments).
    - `src/chat/ChatRuntime.tsx` now composes Chat's DM, group, contact, profile and attachment
      behaviour without a wallet context. Its DM subscription is not gated by page visibility,
      so mounting this provider in `App` will keep the cache and unread count current off-page.
      Scanner and group-rename behaviour moved to chat-only hooks. The runtime/page remain
      temporarily unchecked while the faithful extraction is integrated, matching the source
      wallet modal; the exception is limited to those two files.
    - `src/chat/ChatPage.tsx` is the standalone page rendering the runtime, preserving mobile and
      desktop two-pane views. `ChatTokenBubble` replaces the wallet payment card with a tested,
      copy-only token surface; the full token is copied even when its display is shortened.
    - `App` now loads an always-mounted `ChatShell` asynchronously. It owns `ChatRuntime` off-page
      and loads `ChatPage` as a second chunk only when Chat is visible. The wallet shell is an
      optional child of that provider (ready to reuse its contacts) but renders only on the wallet
      page; opening Chat neither opens nor prefetches it. Idle wallet prefetch is gone.
    - Production build verification is enforced by `check:startup`: opening Chat's static chunk
      graph may not include the wallet modal/runtime, Cashu SDK or payment-support chunks. After
      this integration startup is 451.1 KB gzipped (470 KB budget), and the Chat graph passes.
    - Page splitting is complete: the conversation list/search/profile entry is
      `chat/views/ChatThreadsView.tsx`; the full message conversation and composer are
      `chat/views/ChatConversationView.tsx`; the new-message list, contact detail and contact
      editor are `chat/views/ChatContactsView.tsx`; group info, member list, group-name editing
      and both new-group steps are `chat/views/ChatGroupViews.tsx`; and the profile, contact,
      message, share and scanner sheets are `chat/views/ChatOverlays.tsx`. Each reads the same
      runtime context without a prop matrix, and the original branches were moved without
      behaviour changes. `ChatPage` is now the 85-line layout shell that routes those views.
    - Regression caught before this step was committed: removing Chat's automatic payment action
      also removed the still-live wallet's opt-in payment handler because both consume the same
      DM hook. The handler is now an optional bridge: wallet passes it, Chat does not. A focused
      test protects both sides of that boundary.
    - The dead Chat page branch is gone from `CashuWalletModal`. The wallet modal now reads
      contact state from `ChatRuntime` through `useWalletContactsRuntime`, and the extracted
      `WalletContactsPickerSheet` uses that runtime while the wallet supplies only its
      payment-selection callback. `ChatRuntime` owns the single contacts syncer; the modal no
      longer runs `useContactsState` or `useContactsSync`.
    - `WalletContactsPickerSheet.test.tsx` locks the boundary: Chat owns contacts, their
      presentation state, and NIP-05 verification; the wallet contributes only the callback that
      applies a contact to the send flow.
    - `CashuWalletModal` is now wallet-only. Its unreachable Messages/Contacts tab branches,
      chat composition and remaining DM/group hooks are gone, reducing it from 7,096 to 4,290
      lines. `CashuWalletShell` no longer accepts inbox, DM or contact-management callbacks, and
      `useContactPaymentActions` retains only the wallet's contact-payment behaviour. Contact
      selection and scanned-contact metadata read the Chat-owned runtime without moving ownership
      back into the wallet.
    - The full PWA gate, production build and startup graph pass after that removal: 546 tests
      pass (12 skipped), startup is 450.7 KB gzipped against the 470 KB budget, and the Chat route
      still contains no wallet, Cashu SDK or payment-support chunks.
    - Wallet-off verification found and fixed one real bug: a direct `/wallet` route could render
      the lazy wallet shell for one frame before the redirect effect ran, fetching Cashu on a
      device where the wallet was disabled. `useWalletShellState` now gates both rendering and
      prefetching synchronously on wallet availability. The regression test failed first, then the
      full gate passed with 547 tests (12 skipped) and a 450.8 KB startup graph; Chat remains
      mounted off-page for DM sync/unread updates and its route graph contains no wallet or Cashu
      chunks.
    - Chat typing pass 1 removes `@ts-nocheck` from the five derived-data hooks
      (`useScannedContactDerived`, `useContactsDerived`, `useThreadUnreadCounts`,
      `useDmMessageDerived`, and `useDmThreadDerived`). Their inputs now have explicit contracts,
      two stale thread-derivation inputs are gone, and the lint exemption is an explicit allowlist
      of the remaining unchecked hooks instead of a wildcard that could hide new debt.
    - Chat typing pass 2 checks the contact state and lookup boundary. `useContactsState` and
      `useContactLookup` no longer use `@ts-nocheck`; their callback dependencies are explicit and
      npub encoding now follows nostr-tools' hex-string contract instead of passing a byte array
      through an unchecked call.
    - Chat typing pass 3 checks `useChatGroupDerived` and `useContactDetail`, gives their contact,
      group, identity and profile-photo inputs explicit contracts, and removes eight stale runtime
      arguments. It also found a real profile-photo bug: when a browser could load an image but
      not create a 2D canvas context, the processor returned a string that its caller treated as an
      upload object and lost the draft. A failing test was added first; the fallback now preserves
      the original data URL and blob.
    - Chat typing pass 4 checks `useDmState`. The hook's attachment guard now accepts only the
      documented union members, malformed cached attachments become plain text, and profile relay
      entries are narrowed to strings. A focused test covers each valid attachment type plus
      malformed input.
    - Chat typing pass 5 checks `useDmThreadActions` without changing behavior. Its state refs,
      setters, group/contact inputs and callbacks now have explicit contracts, and the legacy
      dependency-array exceptions are gone.
    - Chat typing pass 6 (2026-10-18) checks `useDmThreadUtils`: explicit contracts for thread
      navigation, unread items, contact shares, refs and setters; the unused group ref argument
      is removed and callback dependencies are complete. Existing error-message and navigation
      behavior is preserved. PWA lint, `tsc -b` and Vitest pass (556 tests, 12 skipped).
      This is React orchestration; Rust/UniFFI/WASM would add a boundary without a gain.
      The attachment tray updater issue found here is fixed in the separately tested step below.
    - Cache regression fix (2026-10-18): restored relay trimming before deduplication in
      `normalizeCachedContactProfile`, accidentally removed during typing pass 4. The regression
      test first failed with whitespace and duplicate relay URLs, then passed with the original
      normalization restored. This changes no wire contract. Attachment tests validate recognized
      type tags only; full attachment payload validation is not claimed.
    - Chat typing pass 7 (2026-10-18) checks `useNostrSession`. Identity refresh has an explicit
      three-value dependency tuple matching the existing wallet caller; subscription cleanup
      tracks its ref, publishing takes the event contract, and pool close uses its zero-argument
      API (the old relay argument was ignored). New lifecycle tests cover refresh, listener cleanup,
      disabled identity and subscription release without network access. PWA lint, `tsc -b` and
      Vitest pass (560 tests, 12 skipped). Decryption and wire behavior are unchanged.
    - Attachment-tray fix (2026-10-18): three regression tests first reproduced duplicate blur
      timers under StrictMode and stale blur after close/unmount. The updater now only toggles
      state; an effect owns the timer and cancels it on close/unmount. PWA lint, `tsc -b` and
      Vitest pass (563 tests, 12 skipped). A fresh headless Brave profile loaded the real hook
      from the configured Vite dev server and verified open → one native blur → close under
      StrictMode, with external web/relay URLs blocked. This was an isolated browser harness,
      not end-to-end Chat or two-account messaging verification; no account or board was created.
    - Chat typing pass 8 (2026-10-18) checks `useDmSend`. Its state setters and session callbacks
      derive their contracts from the owning hooks; the missing file-server type import is fixed,
      and reaction/file callbacks include their refs and setters in dependencies. Message encoding,
      encryption, publication and attachment progress are unchanged. PWA lint, `tsc -b` and Vitest
      pass (563 tests, 12 skipped).
    - Chat typing pass 9 (2026-10-18) checks `useContactsSync`: its options are derived from the
      contacts-state and Nostr-session hooks that own them, module-level helpers left the
      dependency arrays, and the refs and setters it uses joined them. Sync, NIP-51 migration and
      profile publishing are unchanged. PWA lint, `tsc -b` and Vitest pass (563 tests, 12 skipped).
    - Chat typing pass 10 (2026-10-18) checks `useDmSubscription`, the last unchecked chat hook.
      Its options derive from `useDmState`, `useContactsState` and `useNostrSession`; the
      wallet's optional payment-request bridge has a named handler type. Dependency arrays now
      list the refs and setters they use and drop module-level helpers. All additions are stable,
      so the subscription does not restart more often (checked in the browser: no new requests
      over 4 s on Chat, no console errors). The empty hook allowlist left eslint.config.js. Lint,
      `tsc -b`, Vitest (563 tests, 12 skipped) and the startup check pass; the Chat route still
      has no wallet or Cashu chunks.
    - Chat typing pass 11 (2026-10-18) checks `ChatRuntime`, `ChatPage` and the five view
      modules; no file under `src/chat` is exempt any more. The context type is now derived from
      the runtime's value (`ChatRuntimeValue`), replacing `Record<string, any>`, so a view that
      reads a name the runtime does not provide fails to compile. That found two regressions
      from the extraction, both now fixed:
      - Opening any conversation crashed: the view read `chatAttachTrayHeight`, which the
        runtime never passed on.
      - Sending a contact card into a conversation would have thrown: its handler was dropped
        when the Cashu modal became wallet-only. It now lives in `useDmThreadActions`.
      Three latent bugs the types exposed are also fixed:
      - Opening a stranger's contact card from the conversation header crashed when no profile
        was cached.
      - "Add again" on a shared task could call a missing handler; it is now shown only when
        the handler exists.
      - Reaction and forward lists fell back to a profile `name` field that does not exist;
        they now fall back to the username.
      Other changes:
      - `PendingCalendarInvite` is now an alias of the calendar's `CalendarInvite`.
      - The profile card is memoized, so the NIP-05 check effect no longer runs on every render.
      - Dependency arrays list the stable refs and setters they use.
      - The temporary `scripts/chat-extraction` folder is deleted.
      Checks: lint, `tsc -b`, Vitest (563 tests, 12 skipped) and the startup check pass, and the
      Chat route has no wallet or Cashu chunks. In the browser, a conversation, the attachment
      tray and the contact picker open without errors.
  - **Remaining:** live two-account messaging verification (needs two devices or accounts;
    the dev pane cannot do it).
  - Payment-related: 38 of the 373 values the chat UI used were wallet values; they were removed
    during the extraction.
- **Moving Chat out of the wallet code (chunk 5, scoped 2026-10-17):** Chat is 2,878
  lines of JSX inside `CashuWalletModal.tsx` (10,054 lines) and uses 373 values from that
  component's scope, 38 of them payment-related (ecash and Lightning in chat, history). Its DM
  and contact hooks (`useDmState`, `useDmSubscription`, `useDmSend`, `useDmThreadUtils`,
  `useDmThreadActions`, `useContactsState`, `useContactsSync`, `useContactLookup`, ...) are
  already separate files, but the modal composes them interleaved with `useCashu` and the
  payment hooks. Plan:
  1. A `ChatRuntime` provider mounted by `App` that owns the DM and contact hooks, so DMs sync,
     notify and count unread without the wallet.
  2. Split the chat JSX into components by view (threads, conversation, new message, group
     info/members/name, new group) reading the runtime.
  3. Decide what happens to payments in chat under the wallet phase-out (chunk 6): keep them
     behind a lazily loaded wallet bridge, or remove them. This is the maintainer's call.
  4. `App` renders Chat as its own page; Cashu no longer loads to show Chat.
  It needs end-to-end messaging tests with two accounts, which the dev Browser pane can't do
  alone.
  - When an editor pane opens over the card being edited, scroll that card into view.
- **Found while doing this:** the PWA always renders dark (`useAppAppearance` removes `light`),
  so the ~106 `html.light` rules across the stylesheets are dead; logged for chunk 14 hygiene.
- **Earlier proposed direction (kept for reference):**
- **Maintainer requirements (2026-10-17):**
  - The side navigation wastes space as it is; putting the boards in the rail makes that space
    useful. (Confirms the rail-with-boards direction.)
  - Boards with many lists must be easy to scroll sideways with an ordinary mouse, which has no
    sideways wheel.
  - Lists keep the same width on desktop and mobile (2026-10-17, after pass 1 briefly let week
    columns shrink to fit seven days on screen). Desktop uses extra width to show more lists,
    never narrower or wider ones.
  - Overall: a polished desktop experience that is beautiful and makes good use of the space,
    yet still feels like the same app as the mobile PWA (same components, colors and
    interactions; only the arrangement changes).
- **Sideways scrolling, planned:** the vertical wheel scrolls the board sideways when the pointer
  is over the board itself and not over a list that can still scroll; dragging empty board
  space pans; edge arrow buttons appear when lists are hidden off either side; keyboard
  shortcuts move between lists. Week boards should fit all seven days, so they rarely need it.

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
  Done in C4-4.
- Chunk 4: `maybePublishTask` mutates `task._nostrAt` on objects held in state. Done in C4-2.
- Chunk 3: check on a device that opening `/upcoming` directly lands on today. Confirmed as a
  real bug in a visible tab on 2026-10-18; it is C3-2.
- Chunk 12: the CLI's runtime tests assert on source text; build a fake-session harness.

## Chunk 3 — PWA boards, tasks, Upcoming and calendar

Boards, task and event cards, the task and event editors, Upcoming, and the task and calendar
domain code. The desktop layout (C3-1) was done first, at the maintainer's request (see
"Desktop layout" above).

What the review found:

- **The domain layer is in good shape.** Task and calendar mutations are pure, tested commands
  (`taskCommands`, `calendarCommands`, about 1,000 lines of tests). Recurrence lives in
  `taskify-core` with shared vectors.
- **Upcoming opens at the oldest day, not today.** Opening `/upcoming` in a visible tab (checked:
  animation frames running) showed Wednesday, January 1, 2025. The Today button works. The
  arrival scroll runs once, before the virtualized list has measured itself, then marks itself
  done.
- **"Today" is written as a UTC round-trip in 12 places** (`isoDatePart(new Date().toISOString())`).
  The review first read this as a UTC-date bug. It is not: core's `isoDatePart` parses the ISO
  string back into local time, so the result is the local date (checked at 20:30 in Chicago).
  The pattern only hides its intent; see C3-3.
- **Typing a task re-renders every card.** Measured with a render counter on a week board:
  every keystroke in an inline "New Task" field re-rendered every card (28 card renders for
  5 keys with 4 tasks, React's dev double-render included). The causes:
  - The inline-add drafts are `App` state, so each keystroke re-renders `App`, about 8,400 lines.
  - `BoardTaskCard` passes new callbacks to the memoized `Card` on every render, which defeats
    the memo.
  - The board views are not memoized.

  Selecting one card has the same reach. On a board with hundreds of tasks, this is the main
  source of input lag.
- **The two editors are the largest unchecked files.** `EditModal` is 3,061 lines and
  `EventEditModal` 2,236. Each is one component with 58 and 42 `useState` hooks, and both are
  `@ts-nocheck`. They share about 195 identical lines: the time picker, reminders, time zone,
  repeat rows, attachment rows and contact pickers.
- **Bounties keep the wallet inside tasks.** The task editor imports `useCashu`, ecash locking and
  the bounty sheets (212 wallet or bounty references). The card's checkbox branches on bounty
  state. `App` holds reveal, transfer and claim handlers and the bounty list. Turning the wallet
  off is not possible until tasks stop depending on it, as Chat did.
- **`App.tsx` still holds about 1,900 lines of board features**, all in the startup chunk:
  - the paste-JSON import parser (about 510 lines);
  - the Bible tracker handlers (about 570);
  - the print and scan handlers (about 570);
  - the completion and arrival animations (about 270).
- **Opening the app loads the document viewer.** A card's media row imports `DocumentThumbnail`
  from `DocumentPreviewModal`. That puts the preview modal, its viewers and DOMPurify (11.6 KB
  gzipped alone) on the startup path.
- **Note Markdown is implemented twice without shared vectors.** `domains/tasks/noteMarkdown.ts`
  mirrors iOS's `TaskNoteMarkdown.swift` by comment only. Recurrence and links have shared
  vectors in `taskify-core/fixtures`; notes do not.
- **Accessibility basics are in place.** The checkbox and the card's edit target are keyboard
  reachable and labelled, and selection offers a non-drag way to move tasks.
- **Language fit:** the note Markdown parser is the one candidate. It is pure, has two copies
  that must agree, and would move with a C1-6 Rust core if that goes ahead. Nothing else here is
  CPU-bound.

### C3-2 — Upcoming opens on today (bug)

- **User:** Everyone who opens Upcoming from a link, a reload or the tab bar.
- **Proposal:** Scroll on arrival once the virtualizer has measured the target row. Retry until
  the row is in view, or start from an initial offset computed from the row index. Only then mark
  the arrival as handled. Write a failing test first, with jsdom layout stubs and the virtualizer.
- **Effort:** S. **Risk:** low.

### C3-3 — One named local "today" (clarity; first filed as a bug)

- **Correction:** the suspected bug does not exist (see the findings). What remains is clarity:
  the round-trip reads as UTC and misled this review.
- **Proposal:** Add `todayDateKey(now?)` to `taskify-core` and use it at the 12 call sites, with
  a lint rule against the round-trip. A core test pins the evening case.
- **Effort:** S. **Risk:** low.

### C3-4 — Typing and selecting re-render only what changed (performance)

- **User:** Anyone with large boards, most of all on mid-range phones.
- **Proposal:**
  - Inline-add drafts live in the add form, not in `App`.
  - `Card` takes the task and reads stable actions from context, so its memo holds.
  - Per-card view state (selected, pending sync, streak) comes from a small store read with
    `useSyncExternalStore` selectors, so selecting one card re-renders that card only.
  - Board views are memoized.
- **Measure, don't assume:** React Profiler on a seeded 300-task board, before and after. The
  target is no card renders per keystroke and one per toggled selection.
- **Effort:** M. **Risk:** low–medium (selection and drag-and-drop are touched; both are tested).

### C3-5 — Typed editors built from shared fields (architecture, UX consistency)

- **User:** Everyone who edits a task or event; indirectly, every future editor change.
- **Proposal:**
  - Shared, typed field components in `ui/editor/fields/`: time picker, reminders, time zone,
    repeat, attachments and people.
  - Each editor gets a pure form model (draft to `Task` or `CalendarEvent` and back) with tests.
  - The two editors become compositions of those fields, and `@ts-nocheck` comes off both.
  - Migrate one field at a time, checking both editors on phone and desktop after each.
- **Effort:** L, staged. **Risk:** medium; these are the most used screens.
- **Depends on:** C3-6 for the bounty section, so the task editor is not typed around wallet code
  that is about to leave.

### C3-6 — Tasks independent of the wallet (wallet phase-out) — decision needed

- **User:** Everyone, once the wallet is turned off; today's bounty users until then.
- **Proposal:** Do for tasks what was done for Chat. Task cards, the editor and `App`'s task
  handlers carry no wallet code. Bounty UI becomes an optional wallet extension: an editor section
  slot and a card-action bridge, loaded only where the wallet is enabled. With the wallet off, a
  task that carries an ecash bounty shows its token as copyable text, so funds stay recoverable.
  This matches the Chat decision.
- **Decision needed:** keep bounty creation as a wallet extension until the wallet is removed, or
  stop offering new bounties now and keep only reveal/copy for existing ones.
- **Effort:** M. **Risk:** medium; bounty tokens must never become unreachable (tested).

### C3-7 — Board features out of `App` (architecture, performance)

- **Proposal:**
  - The paste-JSON parser moves to `domains/tasks/inlineImport.ts`, pure and tested.
  - The Bible tracker handlers move to a scripture hook beside the model split out in stage 4.
  - The print and scan handlers join the lazy `ui/print` module.
  - The animations move to `ui/task/taskAnimations.ts`.
- **Expected:** `App.tsx` about 8,400 → 6,500 lines, and the print code leaves the startup chunk.
  Startup is measured before and after.
- **Effort:** M. **Risk:** low; each move is behaviour-preserving, one commit per feature.

### C3-8 — The document viewer off the startup path (performance)

- **Proposal:** `DocumentThumbnail` gets its own module. The preview modal, viewers and
  DOMPurify load when a document opens. The startup check gains `DocumentPreviewModal` in its
  lazy list.
- **Expected:** about 15 KB gzipped off startup (DOMPurify alone is 11.6 KB).
- **Effort:** S. **Risk:** low.

### C3-9 — Shared note Markdown vectors (interop)

- **Proposal:** `taskify-core/fixtures/note-markdown-vectors.json` holds input and expected
  blocks, checklist toggles and UTF-16 offsets. Vitest and the Swift tests both run it, as they
  do for recurrence. Drift between the two parsers then fails CI on both sides.
- **Effort:** S–M. **Risk:** low.

### Follow-up found during C3-5

- **Event attachments are stored inline.** The event editor reads attached files into data URLs
  that travel inside the event to relays, while task attachments are encrypted and uploaded to
  the file server (only a link travels). Large files make events large and slow to sync. Moving
  events to the task path changes what other clients read, so it needs a parity check with iOS
  first (chunk 8/9).

### Recommended order

C3-2 (bug) and C3-3 → C3-8 → C3-4 → C3-7 → C3-6 (after the decision) → C3-5 → C3-9. Each
step is one commit, and bugs get a failing test first.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C3-1 | Approve | 2026-10-17 | Done (passes 1 and 2, two-pane Chat) |
| C3-2 | Approve | 2026-10-18 | Done: `lib/settleScroll` keeps correcting until the day sits at the top (estimates were 32/120 px against measured 23/70, and StrictMode remounts reset the scroll); tested, checked in dev and a production build |
| C3-3 | Approve | 2026-10-18 | Done as a clarity change: not a bug (the round-trip already gave the local date). `todayDateKey()` in core with an evening test; 12 call sites use it; lint rejects the round-trip |
| C3-4 | Approve | 2026-10-18 | Done. New Task drafts live in `ui/board/inlineDrafts` (outside React state), cards are memoized with stable callbacks, and each card selects its own view state from a store. On a 300-task board (`boardRenderIsolation.test.tsx`): a keystroke went from 300 card renders to 0, and a selection toggle from 300 to 1 (entering selection mode still updates every card, which shows a checkbox). Confirmed in the browser: 0 card renders per keystroke |
| C3-5 | Approve | 2026-10-18 | Done. Both editors are type-checked (no `@ts-nocheck`). Shared, typed fields in `ui/editor/fields`: `WheelTimePicker` (was written out five times), `ReminderChips` (with pure `reminderSelection` rules), `RepeatField` (with `recurrenceLabel`/`endRepeatLabel`; events now get the richer labels, and end dates read in the item's zone), `AttachmentList`, `ContactRow` and `ContactShareSheet`. Pure form models with tests: `taskEditorModel` and `eventEditorModel`; untouched event times now keep their exact instants. `EditModal` 3,061 → 1,783 lines (with C3-6); `EventEditModal` 2,236 → 1,486. Checked in a production build: time wheels, reminders, repeat, send sheet, and saving a task and an event |
| C3-6 | Approve; bounty creation stays as an optional wallet extension until the wallet is removed | 2026-10-18 | Done: bounty editing (attach, lock, sign over, redeem, pin) moved verbatim to `ui/wallet/TaskBountyEditor.tsx`, loaded only where the wallet is enabled through the editor's bounty slot (`ui/task/taskBountyExtension.ts`). Without the wallet the editor shows `TaskBountyToken` (reveal a locked token with Nostr keys, copy the token; tested) and the card checkbox copies an unlocked token. A lint rule keeps task, board, calendar, Upcoming and print code free of wallet imports. `EditModal` 3,061 → ~2,460 lines. Checked in a production build: with the wallet off the editor shows no bounty controls; with it on, "Attach bounty" and "Pin task" load and the attach sheet opens |
| C3-7 | Approve | 2026-10-18 | Done in four commits: paste-JSON import (`domains/tasks/inlineImport.ts`, tested), Bible tracker commands and store (`bibleTrackerCommands.ts`, `useBibleTrackerActions`, tested; results no longer recorded inside setState updaters), printing and PDF export into the lazy print module (`ui/print/printOutput.ts`), and the fly animations (`ui/task/flyAnimations.ts`, destination logic tested). `App.tsx` 8,388 → 6,881 lines; startup 428.6 → 426.6 KB gzipped. Printing itself could not be exercised in the dev pane (it blocks popups); its code and stylesheets moved verbatim |
| C3-8 | Approve | 2026-10-18 | Done: `DocumentThumbnail` and `documentAsset` are their own modules; an HTML thumbnail loads the sanitizer on demand (tested). Startup 441.0 → 428.3 KB gzipped; the startup check fails if DOMPurify returns |
| C3-9 | Approve | 2026-10-18 | Done: 34 vectors in `taskify-core/fixtures/note-markdown-vectors.json` (blocks, checklist toggles, list continuation with UTF-16 offsets, formatting, previews), run by Vitest and by Swift `NoteMarkdownVectorTests`; both pass, so the two parsers agree today |

## Chunk 4 — PWA sync and storage

How tasks, boards and events reach the relays and come back, and how they are stored on the
device: `nostr/` (about 10,600 lines with tests), `storage/`, `domains/nostr`, and the sync code
still in `App.tsx` (now 6,913 lines).

What the review found:

- **The publishing side is well built.** `BoardPublisher` owns ordering: reserved timestamps,
  supersession of in-flight edits, durable deletion tombstones, metadata before items. Keys,
  crypto and the network are injected and the rules are unit-tested. Signed events go through
  a durable outbox (`NostrOutboxStore`) that retries until relays acknowledge them.
- **An edit that fails before it is signed is lost to other devices (confirmed).** The outbox
  only holds *signed* events. Everything before signing (attachment upload, key derivation,
  encryption) runs in memory, and `App` calls `maybePublishTask(...).catch(() => {})`. A probe
  against the real `BoardPublisher` showed what happens when an image is attached offline:
  - the upload throws and the publish rejects, so nothing is sent or queued;
  - the "syncing" mark is cleared, so the task looks synced;
  - the task keeps the new local version stamp, so this device protects the edit, and no
    later sync sends it, because the relays already hold an (older) copy.

  The same happens if the app is closed between an edit and its signing. `App.tsx` has 48
  swallowed `.catch(() => {})` calls, most on publish paths.
- **Version stamps live on task objects.** `publishTask` writes `task._nostrAt` onto the object
  held in the store (logged in chunk 2). It reaches IndexedDB only because the write happens
  to be queued after the mutation; nothing guarantees that.
- **The receive path is in `App` and is tested only through copies.** Applying incoming task,
  board and calendar events, and merging each relay's batch at end-of-stored-events, is about
  600 lines inside `App`. `relaySyncBehavior.test.ts` and `startupStability.test.ts` (1,003
  lines) test inline re-implementations "mirroring" that code, so they pass whatever the real
  code does. The rule that matters most, that relay data never regresses local data, is not
  tested against the code that applies it.
- **App backup and scripture sync: one pattern, three copies, no tests.**
  `useNostrAppBackupSync` (972 lines, 78 hooks) syncs three encrypted replaceable documents
  (the app backup, the Bible tracker, scripture memory). Each has its own base, local and
  remote state and three-way merge wiring, and none of it is tested.
- **Logged from chunk 2:** Scripture Memory review tasks whose series fields are normalized
  are not republished, and republishing would resend every past review.
- **Storage is sound.** Per-entity IndexedDB stores with diff writes and a serialized write
  chain; `kvStorage` is the only `localStorage` gateway (enforced in development); a storage
  failure banner.
- **Language fit:** nothing here. The crypto is in audited libraries, and the sync rules are
  small and must stay readable next to their tests.

### C4-1 — Durable publish intents (bug, data durability)

- **User:** Anyone who edits offline, attaches files on a weak connection, or closes the app
  quickly; and everyone they share boards with.
- **Proposal:** Record *what needs publishing* durably, before any asynchronous work.
  - A `PublishIntentStore` (IndexedDB) holds item kind, id, board and local version. It is
    written in the same step as the local change.
  - A publish worker drains intents on startup, on reconnecting (`online`) and when a relay
    recovers, with backoff. Each attempt re-reads the item's current local state, so the
    latest edit is what goes out. An intent clears only once its signed event is in the
    runtime outbox, which already handles relay acknowledgements.
  - The sync indicator is "intent or outbox entry pending". A failing item shows "Couldn't
    sync — retrying" instead of looking synced.
  - Local version stamps move off task objects into the ledger and intent store, which fixes
    the logged `_nostrAt` mutation.
  - The swallowed `.catch(() => {})` calls on publish paths go away.
- **Test first:** the probe above becomes a failing test (offline attachment edit, then
  reconnect: the edit is published once).
- **Effort:** M–L. **Risk:** medium; this is the core sync path, staged behind the existing
  publisher and outbox.

### C4-2 — The receive path out of `App`, tested for real (architecture, test quality)

- **Proposal:** Move the incoming task, board and calendar handling and the per-relay batch
  merge into `nostr/boardItemReceiver.ts`: pure decisions (accept, merge, tombstone) plus a thin
  hook. Replace the two "mirror" test files with tests of the real code, keeping their
  scenarios. Expected `App.tsx` reduction: about 600 lines.
- **Effort:** M. **Risk:** medium; behaviour-preserving, with the scenarios ported first.

### C4-3 — One engine for encrypted replaceable documents (architecture)

- **Proposal:** A small, tested engine for "one encrypted replaceable document per d-tag,
  three-way merged with a stored base". The app backup, Bible tracker and scripture memory
  become three configurations of it. Tests cover first sync, concurrent edits on two devices,
  a stale relay copy and decryption failure.
- **Effort:** M. **Risk:** low–medium.

### C4-4 — Generated-task normalization never republishes (decision)

- **Proposal:** Normalizing generated tasks (Scripture Memory reviews, fasting reminders) is
  deterministic local bookkeeping. Every device applies it on read, and a change made only
  by normalization is never published. That avoids resending past reviews while keeping
  devices consistent. Tested with two simulated devices.
- **Effort:** S. **Risk:** low.

### Recommended order

C4-1 (it loses edits today) → C4-2 → C4-3 → C4-4. One commit per step; the bug gets its
failing test first.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C4-1 | Approve | 2026-10-19 | Done: `nostr/durablePublisher.ts` records every task and event publish (and deletion) before any async work, keeps it on failure, retries with backoff (5 s, 15 s, 60 s, then 5 min), on reconnecting and on the next launch, and sends the item as it is at retry time; items with a waiting change stay marked as syncing. Intents are preloaded at startup. 43 swallowed `.catch(() => {})` calls on publish paths removed (board metadata, re-sent ahead of every item, keeps its catches). Tests: 8, including the offline-attachment case. Checked in a production build: edits queue and clear, and a stored intent is resumed after a reload. Not done: version stamps still live on task objects (`_nostrAt`); moving them belongs with C4-2, which owns the receive side that reads them |
| C4-2 | Approve | 2026-10-19 | Done in three commits. The task merge, per-relay batching, live application and update coalescing are `nostr/taskSyncMerge.ts`; board metadata is `applyBoardMetadata` (`nostr/boardEventMerge.ts`); the calendar list upsert joined `calendarEventMerge`. All are used by App and `useBoardSync` and tested directly. Both "mirror" test files are gone: their scenarios run against the real code (`taskSyncMerge.test.ts` with a real `BoardSyncLedger`; `SubscriptionManager` in taskify-runtime-nostr; `SessionPool`). Task version stamps (`_nostrAt`) are no longer written onto task objects: the publisher records them through the task store (`recordTaskVersion`), so they are saved deliberately. `App.tsx` 6,913 → 6,758 lines, less than estimated: decoding and orchestration stay in `App`, and the parse and merge code was already in modules |
| C4-3 | Approve | 2026-10-19 | Done for the Bible tracker and scripture memory: both are configurations of `nostr/mergedDocumentSync.ts` (three-way merge with a stored base, debounced and serialized publishing, first-use publish, echo and stale-copy rejection, key changes), run by `useMergedDocumentSync`; 8 engine tests (first use, a second device, concurrent edits on two devices, echoes, unreadable copies, debounce, publishing before the pull, switching keys). Stored state and base keys are unchanged, so devices keep their sync position. `useNostrAppBackupSync` 972 → 556 lines. The app backup (boards and settings) stays as it was: it is a whole-snapshot backup with a different restore flow, not a merged document. Checked in a production build: a Bible tracker change published, and the base was recorded |
| C4-4 | Approve | 2026-10-19 | Done: `normalizeScriptureReviewTasks` (`domains/tasks/generatedTasks.ts`) moves every review task, open and done, to the chosen board and frequency, and keeps one copy per id (a completion outlasts an open copy, then the newer version wins). It runs in the planner and, through `sanitizeRecurringTasks`, on both relay receive paths (the initial-sync batch and live events), so a relay copy from before a move is normalized on arrival instead of reverting the move or adding a second copy on the old board. Nothing it changes is published. Fasting reminders needed no change: only open reminders move, and those moves are published, as native does. Tests: 6, including two simulated devices sharing a relay (a board and frequency change on both, re-syncs with a stale copy, a completion on one device); the duplicate cases fail without the change. Checked in a production build: after a frequency change the stored review task recurred weekly, with one copy. Relies on both devices having the same Scripture Memory settings, which the app backup syncs |

## Chunk 5 — PWA chat, contacts, sharing, voice, Bible tracker

Chat (`src/chat`, about 15,300 lines), the share inbox (in `App.tsx` and `lib/shareInbox.ts`),
contacts, voice dictation, the Bible tracker, and printing and scanning (`components/`). Agent
mode was removed before this review (`45f29edb`, superseded by the CLI).

What the review found:

- **Two pipelines read the same gift wraps.** Chat (`useDmSubscription`) and the share inbox
  (`useNostrSubscriptions` plus about 300 lines in `App`) each subscribe to the account's
  kind-4 and kind-1059 events and each open every gift wrap with two NIP-44 decryptions. They
  differ in what they read and remember:

  | | Chat | Share inbox |
  | --- | --- | --- |
  | Relays | the account's NIP-17 inbox relays (kind 10050) | the default relays only |
  | History | full on first run, then watermarks per relay | the last 3 days, every launch |
  | Remembers opened wraps | in memory only | only wraps that held a share (last 400) |

  So on every launch each wrap from the last 3 days is opened at least twice (chat once, the
  inbox once or twice, since its fetch and its subscription overlap). A share that arrives while
  every device is offline for more than 3 days shows in chat but never reaches the inbox. A
  share sent only to an inbox relay the defaults don't include never reaches it either. This
  is the duplication the signer work (chunk 2, C2-4) needs removed: with a remote signer each
  decryption is a round trip.
- **The inbox deletes shares from the relays (PWA only).** After handling a share, the PWA
  publishes a kind-5 deletion for its gift wrap (`sendInboxDeletion`). NIP-59 now says relays
  SHOULD delete a gift wrap when its recipient asks. Where a relay does, the user's other
  devices never receive the share, and it disappears from chat history on a new device. That
  contradicts the rest of the design: chat-state sync carries inbox responses *keyed by the
  wrap id* so other devices can apply them. iOS never deletes. Whether it bites depends on
  each relay; it was not exercised against public relays, since that would publish real
  events.
- **The PWA turns a bare npub into a contact share.** If a message, or JSON in one, is only an
  npub or pubkey, the inbox treats it as a contact share. iOS accepts only real share envelopes
  (parsed by `taskify-core`), so the same message gives different results on the two clients.
- **NIP-17 wrap and unwrap exist in four places, none in `taskify-core`.**
  - Sending: `useDmSend` and `lib/shareInbox`, each with its own copy of the recipient-relay
    lookup (kind 10050).
  - Receiving: `useNostrSession` and `unwrapShareGiftWrap`.
  - The CLI has its own (`shareTransport.ts`).

  Share envelopes already live in core; the transport around them does not.
- **Chat-state sync is a fourth copy of the replaceable-document pattern.**
  `useNostrChatStateSync` (282 lines) holds read markers and inbox responses. It hand-rolls
  what C4-3's `MergedDocumentSync` engine does, plus flushing on tab hide. Its merge
  (`mergeChatSyncStates`, in core) needs no base.
- **Scanning code is duplicated and untested.** `BoardScanSheet` and `BibleTrackerScanSheet`
  each hold about 570 lines of image processing: marker detection, Otsu threshold,
  homography, sampling. Only 22 of those lines differ. No test covers any of it, so a fix in
  one sheet silently misses the other.
- **Dead styles at startup.** `styles/agent.css` is imported by `index.css`, so it loads on
  startup. About 280 of its 400 lines style the removed agent panel; nothing references
  `agent-panel`. The rest are document-viewer and attachment styles filed there by mistake.
- **In good shape:** chat is fully type-checked and walled off from the wallet by lint.
  Contacts sync, through a private NIP-51 list with the legacy kind-3 envelope as a fallback,
  has one owner (`useContactsSync`). Link previews go through the Worker. The Bible tracker's
  model was already moved out in chunk 2. Voice uses the browser's speech recognition. Its
  private-key prop is already on the C2-4 list of sites to move to the signer.
- **Language fit:** none needed. Scanning is the only CPU-bound code. It runs once per photo
  on typed arrays, so WASM would need a measured slow case first. The NIP-17 codec should go
  to `taskify-core`, not Rust (C1-6 still holds).

### C5-1 — Stop deleting received shares from the relays (bug, interop)

- **User:** Anyone with Taskify on more than one device, and anyone opening chat on a new one.
- **Proposal:** Remove `sendInboxDeletion`. A handled share stays where the user's other
  devices can get it, as on iOS. Re-handling is already prevented locally, and across devices
  by the inbox responses in chat-state sync (keyed by wrap id). C5-3 makes that durable.
- **Test first:** handling a share publishes nothing.
- **Effort:** S. **Risk:** low. Shares stay on relays as they do for iOS users today.

### C5-2 — NIP-17 transport in `taskify-core` (interop, simplification)

- **Proposal:** `taskify-core/src/nip17.ts` owns NIP-17:
  - building a message's gift wraps for its recipients and the sender's own copy;
  - opening one;
  - choosing the relays to send to from a recipient's kind 10050.

  Crypto goes through an injected signer (sign, NIP-44 encrypt and decrypt), so the C2-4 signer
  plugs straight in. PWA chat, the PWA share inbox and the CLI use it, and their four copies
  go. JSON vectors of fixed wraps and the rumors they hold are read by the Node tests and by
  Swift (`NostrSharedInbox`), so all three clients open the same wraps the same way.
- **Effort:** M. **Risk:** low–medium; covered by vectors on both sides.

### C5-3 — One gift-wrap pipeline with a per-device store (architecture, performance, bug)

- **User:** Everyone who chats or shares; a prerequisite for NIP-46 signers.
- **Proposal:** Every gift wrap enters through one pipeline.
  - **One subscription,** using chat's relay choice (kind 10050 plus defaults) and its
    watermarked history.
  - **Each wrap opened once per device.** Opened wraps are stored in IndexedDB keyed by wrap id
    (what they held, or "not for this app"). A reload decrypts nothing it has seen.
  - **Routed by content:** a share envelope goes to the inbox, everything else to chat. A share
    still appears in its chat thread, as now.
  - **The inbox becomes a pure command.** `domains/inbox/shareInboxReceiver.ts` takes an opened
    share and the current state and returns the inbox change. It is tested, and leaves `App`
    (about 300 lines).
  - **Envelopes only,** matching iOS: the bare-npub fallback goes. (Decision: a contact shared
    by an older client as a bare npub would show only as a chat message.)

  This fixes the two missed-share cases above, and launch decrypts only new wraps. The wallet's
  payment-request listener keeps its own subscription until chunk 6 removes it.
- **Test first:** a share received 4 days ago reaches the inbox; a reload opens no wrap twice.
- **Effort:** L. **Risk:** medium; staged behind C5-2, with chat's existing tests kept.

### C5-4 — Chat-state sync on the document engine (simplification)

- **Proposal:** Make chat state (read markers, inbox responses) a configuration of C4-3's
  `MergedDocumentSync`. The engine gains `flushPending()` for tab hide. Its 15-second debounce
  and storage keys stay, so devices keep their sync position. About 200 lines go.
- **Effort:** S. **Risk:** low.

### C5-5 — One tested scan engine (simplification, test quality)

- **Proposal:** `domains/print/scanEngine.ts` holds marker detection, thresholding, homography
  and sampling once. It works on plain luma arrays, so tests run without a canvas. Each sheet
  passes its layout and reads the marks. Tests use synthetic pages rendered from each layout,
  including rotation and uneven lighting. About 550 lines go.
- **Effort:** M. **Risk:** low–medium; check with a real printed sheet before and after.

### C5-6 — Remove the agent-panel styles (cleanup)

- **Proposal:** Delete the agent-panel rules. Move the document and attachment styles next to
  their components' stylesheet. This shrinks startup CSS.
- **Effort:** S. **Risk:** low.

### Recommended order

C5-1 (a one-line bug with cross-device effects) → C5-6 → C5-2 → C5-3 → C5-4 → C5-5. C5-3
needs C5-2. The others stand alone.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C5-1 | Approve | 2026-10-19 | Done (`e3fa2159`): the inbox no longer publishes a deletion for a share it handled. Its test ("handling a share publishes nothing") came with C5-3, when the inbox became a command with no way to publish |
| C5-2 | Approve | 2026-10-19 | Done (`8a2d87fd`): `taskify-core/src/nip17.ts` builds rumors (with group tagging), seals, wraps and opens gift wraps, with crypto injected through a signer, so NIP-07 and NIP-46 can plug in. Opening follows iOS: a signed wrap that tags the receiver; a signed seal with no tags; an unsigned rumor naming the seal's author, with a correct id. `taskify-runtime-nostr` adds the nostr-tools adapter. The four PWA copies and the CLI's are gone. Recipient relays come from the runtime's signature-checked `inboxReadRelays`, which both PWA senders had re-implemented without checking. The CLI now also delivers to the recipient's kind-10050 inbox relays. `fixtures/nip17-vectors.json` holds 12 real wraps (6 open, 6 rejected), checked by PWA vitest and by Swift (`NIP17VectorTests`), which agree. Fixed while testing: a copied event kept nostr-tools' cached "verified" mark after its signature changed, so the adapter verifies a clean copy |
| C5-3 | Approve | 2026-10-19 | Done (`f08ac5e8`): chat's subscription (kind-10050 relays, watermarked history) is the only one that opens the account's messages. Shares go to the inbox before the message counts as handled; `App`'s second subscription and its decryption are gone. Opened events persist per device (`chat/seenEvents.ts`, newest 10,000), so a launch decrypts only new messages. Reactions are saved too, and the message cache keeps rumor and reply ids; it had been dropping them on load, so older messages lost reply threading and reaction matching. `domains/inbox/shareInboxReceiver.ts` is the inbox as a tested command. Only real envelopes count (the bare-npub fallback is gone, as on iOS), and shares from blocked senders are dropped with their messages. Deleting a chat thread is now permanent across reloads; before, only the 3-day re-decrypt window was guarded. Fixed while testing: chat passed the sender in compressed "02…" form, which the inbox could not match against assignees |
| C5-4 | Approve | 2026-10-19 | Done (`5e9959c5`): chat state is a configuration of `MergedDocumentSync`. The engine gained general options for it: a payload `codec` (chat keeps the top-level layout iOS reads); `toPublish` (publish a pruned merge only when it adds something, so pruned entries never cause a republish); `debounceMode: "window"`; `flushPending`; and read access to the known relay copy. Storage keys are unchanged, and the hook's five tests pass unchanged. Fixes a change made during an in-flight publish waiting for the next one. Lines: the hook went 282 → 270 and the engine grew by about 70, not the estimated 200-line saving |
| C5-5 | Approve | 2026-10-19 | Done (`7e8895bf`): `domains/print/scanEngine.ts` holds the image processing once, copied verbatim and working on brightness arrays; `scanCanvas.ts` reads a canvas. The sheets pass only their marks and sampling geometry (board sheet 1,122 → 426 lines, Bible 1,204 → 512, engine 735). Six tests on synthetic photos of real layouts, covering fill detection, a blank page, an upside-down photo, a skewed and unevenly lit photo, a cropped page and Bible boxes. Not checked: a real printed sheet through a camera, which the browser pane blocks |
| C5-6 | Approve | 2026-10-19 | Done (`d4c9ccc2`): `styles/agent.css` removed; its document and attachment rules moved, in the same cascade position. Startup CSS 37.6 → 36.9 KB gzipped |

### Also fixed during chunk 5 (`feb780f8`)

Found while verifying C5-3 in a production build: **Scripture Memory review tasks lost their
link to their passage on synced boards.**
- iOS writes and reads `scriptureMemoryId`, `…Stage`, `…PrevReviewISO` and `…ScheduledAt` in
  task events; the PWA did neither.
- A relay re-sync replaced the review with a copy without the link. Completing it then no
  longer marked the passage reviewed, later reviews in the series inherited the gap, and
  removing the passage left the task behind.

The fix:
- The fields now travel both ways (failing tests first).
- `relinkScriptureReviews` reconnects an open review that already lost its link to the one
  passage its title names. It runs in the planner and on read, and is not published.
- Removing a passage now publishes the deletion of its review tasks.

Checked in the build: an orphaned review was relinked, kept the link across a reload, and stayed
deleted after its passage was removed.

**Follow-ups:**
- Live two-account messaging verification (from chunk 2) now also covers shares reaching the
  inbox through chat.
- The real-camera scan check needs a device.

## Chunk 6 — PWA wallet phase-out

What is left of the Taskify wallet in the PWA, and how it ends. The decisions so far:
- **`cd9e02f6`:** the wallet is hidden on devices that never used it and kept where it was used.
  A one-time notice goes to users with a balance, and a close-out returns an emptied wallet to
  the no-wallet state.
- **Chunks 2–3:** chat and tasks work with the wallet off, and received Cashu tokens are
  copy-only.
- **C3-6:** bounty creation stays as an optional wallet extension until the wallet is removed.

What the review found:

- **The wallet is about 35,000 lines, a third of the PWA's own code**, loaded only on devices
  where it is enabled:

  | Area | Lines |
  | --- | --- |
  | `wallet/` | 7,200 |
  | `mint/` | 1,000 |
  | Cashu, NWC and P2PK providers | 2,200 |
  | `hooks/wallet` | 8,500 |
  | `ui/wallet` | 6,000 |
  | Bounty sheets | 700 |
  | `CashuWalletModal` | 4,300 |
  | Wallet settings (unchecked) | 1,200 |

  Its own tests cover the risky parts (proof storage, counters, P2PK, NWC sweeps, secrets at
  rest).
- **Money still flows in.** Wallet users still see **Receive** first: Lightning invoices,
  pasted ecash, and their npub.cash Lightning address. They can still create payment requests.
  The notice asks them to move funds out "immediately", but there is no guided way to do that.
  "Open wallet" lands on the full wallet. The phase-out has no end state: nothing says when the
  wallet goes, or how funds are recovered after it does.
- **Recovery after removal is already possible.** The seed is a standard BIP39 phrase with
  NUT-13 deterministic secrets, so a NUT-13 wallet (Cashu.me, Minibits and others) can restore
  most funds from the 12 words. Every backup also carries the seed: the local file and the
  Nostr app backup. Two kinds of funds need more than the phrase:
  - proofs received and never swapped;
  - P2PK-locked bounties.

  Both can be exported as tokens from stored proofs, without asking the mint.
- **Everyone loads wallet seed code at startup, and every backup creates a seed.** The app backup
  calls `getWalletSeedBackup()`, which creates a seed when there is none. So devices that never
  used the wallet create a wallet seed and publish it in their backup. The seed module, the
  BIP39 word list (6.3 KB gzipped on its own), the availability check and the NWC catalog are
  in the startup bundle: about 12 KB of 430 KB, for everyone.
- **A dead control for every new user (confirmed in the build).** Settings → "Support
  development" says "Donate from your internal wallet" and shows a Donate button. Without the
  wallet there is no mint, so the button is permanently disabled.
- **The inbox lives under the wallet.** Shared tasks, boards and contacts are stored and counted
  by `ui/wallet/useWalletMessages.ts` (`useMessagesBoardId`, `WalletMessageItem`). The inbox is
  not wallet code and must outlive it. `ChatRuntime` also still opens with a stale "wallet
  surface" TODO.
- **Elsewhere:** the in-app debug console (eruda) is switched on from Wallet settings, so it
  needs a new home before those go.
- **Cross-client:** iOS and macOS have their own wallets (chunks 9 and 11). Whatever is decided
  here should be mirrored there in the same release, so a user sees one policy on every device.
- **Language fit:** none. This chunk removes code.

### C6-1 — Withdraw-only wallet with one "Move funds out" path (decision)

- **User:** Everyone who still has the wallet.
- **Proposal:**
  - **Stop new money coming in.** Remove Receive (Lightning invoices, ecash paste), the
    npub.cash address display and payment-request creation.
  - **Keep everything that takes money out or claims what is already owed:**
    - paying a Lightning invoice or address;
    - sending ecash as a token;
    - NWC sweep to the user's own wallet;
    - claiming funds already waiting at npub.cash;
    - redeeming payment requests that already arrived;
    - finishing pending mint and melt quotes.
  - **One "Move funds out" screen.** It shows the balance per mint and three ways out:
    - to your Lightning wallet;
    - copy everything as an ecash token;
    - restore in another Cashu wallet with your 12 words (shows the phrase and instructions).

    The phase-out notice opens this screen instead of the full wallet.
- **Decision needed:** keep bounty creation (C3-6) until removal, or end it here. Creating a
  bounty locks the user's own funds into a task.
- **Effort:** M. **Risk:** medium; every way out must keep working (tested), and pending quotes
  must finish.

### C6-2 — A removal date and a small recovery module (decision)

- **Proposal:** Remove the wallet in stages, on a date the maintainer sets (for example three
  months after C6-1 ships, announced in the notice).
  1. **C6-1 ships:** the wallet is withdraw-only.
  2. **On the date:** the wallet is replaced by a recovery module of a few hundred lines,
     loaded only on devices with funds:
     - the balance per mint, read from stored proofs (no mint calls);
     - copy each mint's proofs as a token;
     - the 12 words with NUT-13 restore instructions;
     - existing bounty tokens, still copyable (C3-6).

     Everything else is deleted (about 30,000 lines): `mint/`, `hooks/wallet`, most of
     `wallet/`, `ui/wallet`, `CashuWalletModal`, the providers, NWC, npub.cash, solife and the
     wallet lint lists. The debug console moves to Settings → Advanced.
  3. **Later:** the recovery module goes too. The phrase stays in backups and is shown in
     Settings → Backup.
- **Decision needed:** the date, and whether iOS and macOS follow the same schedule.
- **Effort:** L, mostly deletion. **Risk:** medium; no balance may become unreachable (tested
  against stored proofs, pending tokens and locked bounties).

### C6-3 — No wallet code at startup, and no seed for non-wallet users (performance, correctness)

- **Proposal:**
  - The app backup and the local backup include the wallet seed only when one exists; they
    never create one.
  - The startup availability check reads only cheap storage flags.
  - The seed module, the BIP39 word list and the NWC catalog load with the wallet or a backup
    restore.
  - The startup budget check fails if they return.

  Saves about 12 KB gzipped at startup for everyone.
- **Effort:** S–M. **Risk:** low; restoring a backup that carries a seed must still restore it
  (tested).

### C6-4 — Donations without the internal wallet (bug, UX)

- **Proposal:** "Support development" offers a `lightning:dev@solife.me` link (opens whatever
  Lightning wallet the user has) and a copy button, for everyone. The internal-wallet donation
  goes, with its wallet dependency in Settings.
- **Effort:** S. **Risk:** low.

### C6-5 — The inbox out of the wallet namespace (simplification)

- **Proposal:**
  - Move `useWalletMessages`, `useMessagesBoardId` and `WalletMessageItem` to
    `domains/inbox`, as `useInboxItems`, `useInboxBoardId` and `InboxItem`, unchanged in
    behaviour and storage.
  - Remove `ChatRuntime`'s stale wallet TODO.
  - Add a lint rule: nothing outside the wallet imports `ui/wallet` except through the
    bounty and wallet-shell seams.
- **Effort:** S. **Risk:** low.

### Recommended order

C6-4 → C6-5 → C6-3 → C6-1 (after its decision) → C6-2 (on the chosen date). C6-1 and C6-2
should be mirrored on iOS and macOS in chunks 9 and 11.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C6-1 | Approve; end bounty creation | 2026-10-19 | Done (`3ecdf37a`): "Move funds out" replaces Receive and opens from the notice (`/wallet/move-out`). It covers Lightning out, one ecash token per mint (exported without the mint and recorded in History, so an unclaimed token can be taken back), NWC sweep, npub.cash claims, and the 12 words with restore instructions. Removed: the receive sheets (and payment-request creation), the npub.cash address page (`/wallet/address` opens the wallet), redeeming scanned tokens (copied instead) and LNURL withdraw. Bounties: no new ones, and a bounty is never redeemed into the wallet (its token is copied); existing ones keep reveal, sign over, copy, mark claimed and remove. The notice announces December 1, 2026 and shows once more. Not exercised: making a token from real funds |
| C6-2 | Approve; date December 1, 2026 | 2026-10-19 | Stage 2 switch done (`58ae4cd5`): from local midnight on the date, the full wallet is off. Devices that had it get a recovery view, which reads storage only and loads no Cashu SDK (enforced by `check:startup`). It shows each mint's notes as a V3 token, saved tokens, unclaimed sent tokens, and the 12 words with mints. A hidden switch previews it, and it was checked that way in a production build. **The release must ship before the date.** Still to do after the date: delete the wallet code (about 30,000 lines) and move the debug console out of Wallet settings. Then stage 3, recovery to Settings → Backup |
| C6-3 | Approve | 2026-10-19 | Done (`eadc4277`): wallet code loads only where wallet data exists (`walletFlags.hasWalletData`), and backups carry a seed only if one exists (never create one). The seed is optional in core's backup snapshot, which iOS and the CLI already allow. BIP39 has its own chunk. Startup 430.8 → 416.9 KB; budget 455 → 440 KB; `check:startup` fails if wallet seed, storage or availability code, or the word list, returns. Checked on a clean profile: no wallet chunk requested |
| C6-4 | Approve | 2026-10-19 | Done (`f55495c7`): Support development offers a `lightning:` link and a copy button for everyone; the internal-wallet donation is gone |
| C6-5 | Approve | 2026-10-19 | Done (`11fc0f3f`): the inbox lives in `domains/inbox` (`useInboxEntries`, `InboxEntry`). Lint: `ui/wallet` is wallet code, and the inbox, lib, identity, routing and onboarding code may not import the wallet |

### Follow-ups from chunk 6

- **Ship before December 1, 2026.** On that date the PWA switches to recovery by itself. Users on
  an older build keep the full wallet until they update.
- **After the date:**
  - delete the wallet code (`mint/`, `hooks/wallet`, most of `wallet/`, `ui/wallet` except
    `WalletRecoveryView`, `CashuWalletModal`, the providers, NWC, npub.cash, solife, the bounty
    editor extension);
  - move the debug console to Settings → Advanced;
  - drop the wallet lint lists.

  Recovery needs only `wallet/storage`, `seed`, `walletRecovery`, `walletPhaseOut`,
  `mintDisplayName` and `walletFlags`.
- **iOS and macOS** follow the same policy and date in chunks 9 and 11.
- **Fixed after chunk 6 (`262f17ab`, maintainer report):** a saved token already redeemed in
  another wallet blocked the close-out forever. Close-out now checks saved tokens with their
  mints (NUT-07), removes spent ones (keeping a copy in History), and lets the user remove one
  that cannot be checked. The redeemer now also resolves tokens it could not fully decode. iOS
  has the same close-out, so chunk 9 checks it for the same case.

## Chunk 7 — iOS TaskifyCore

The Swift core the iOS, iPadOS, watchOS and macOS apps share: about 32,000 lines (`Nostr` 8,900,
`Wallet` 6,900, `State` 5,700, `Sync` 3,500), with about 20,000 lines of tests in 88 files. Task
publishing itself is orchestrated in the app target's `AppModel.swift`, which is part of this
chunk because the sync rules live there.

What the review found:

- **The transport is well built.** `TaskSyncEngine` is an actor with:
  - a durable outbox of signed events, per-relay pacing, proof of work and NIP-42 AUTH;
  - rate-limit and ban backoff, and startup batches.

  Receiving is simple and safe: a strictly newer event wins, and unknown fields are kept
  (`preservedSyncFields`). The core passes this review's NIP-17 vectors (C5-2), writes the
  Scripture Memory link fields, keeps received shares, and accepts only real share envelopes.
- **An edit can be lost before it is queued (confirmed by reading; same class as PWA C4-1).**
  `synchronizeTasks` stores each task's `publishedFingerprint`, and saves it, before the event
  is encoded, encrypted and signed in a detached task and queued:
  - if the app is killed in between, the saved state says "published" while nothing was queued;
  - if queueing fails, the fingerprint is cleared only in memory, and nothing republishes the
    task until it is edited again. Meanwhile the empty outbox reads as synced.

  No launch or reconnect pass compares stored fingerprints with the tasks.
- **The sync rules live in the app target.** `AppModel.swift` is 6,988 lines with 268
  functions. Stamping, fingerprints, publish ordering, Scripture Memory reconcile and the
  account backup sit there, out of reach of the TaskifyCore tests.
- **One JSON file holds all state, rewritten 300 ms after any change.** Boards, tasks
  (tombstones included), every chat message, contacts, events and inbox items. Measured with
  2,000 tasks and 5,000 messages: 2.56 MB per save, 27 ms to encode on an M-series Mac (more on
  a phone), plus the atomic write. The whole file is decoded at launch and read by widgets and
  intents. Documents can carry inline `dataURL`s, which grow it further.
- **Cross-client rules are written twice with no shared vectors:**
  - the task event payload (encode and decode), where the Scripture Memory link fields were
    missing on the PWA side until this review;
  - the app-state merges (Bible tracker, Scripture Memory, chat state);
  - what wins when two versions share a timestamp. iOS keeps its own copy, and so does each PWA
    device in most paths. Two devices that publish in the same second (for example, both
    generating the same date-derived reminder) can then disagree until the next edit. Relays
    keep the lowest event id (NIP-01).
- **Parity gaps:**
  - **PWA app backup (found here):** iOS updates the latest verified remote backup and
    publishes only when it has one. The PWA publishes its own snapshot whenever local state
    changes, without checking that it has read the remote copy (a failed read still counts as
    "finished"). A device that starts offline and then changes a board replaces the backup with
    only its own boards, dropping other devices' boards and, when it has no seed, the wallet
    seed. That seed is what recovers funds after December 1.
  - **Scripture Memory relink:** the PWA reconnects review tasks that lost their passage link
    (`relinkScriptureReviews`); iOS has no equivalent, so such tasks stay unlinked there. iOS
    also publishes open reviews when it normalizes them, which the PWA does not; that is
    harmless, because both converge.
  - **Wallet:** the withdraw-only rules, the December 1 date and the saved-token close-out fix
    belong to chunk 9.
- **Language fit:** none. The shared vectors (C7-3) catch drift at a fraction of the cost of a
  shared Rust core (C1-6).

### C7-1 — iOS: no edit lost before it is queued (bug, architecture)

- **Proposal:** Make the fingerprint mean "queued", and reconcile from it:
  - a `TaskPublisher` in TaskifyCore owns stamping, fingerprints, encoding and queueing;
  - the fingerprint is recorded only once the event is in the durable outbox;
  - on launch, on reconnect, and after a failure (with backoff), every task whose current
    fingerprint differs from its recorded one is published again.

  This makes the intent state-derived, so there is no second store to keep in step. The
  "syncing" indicator counts these tasks as well as the outbox. `AppModel` keeps only the call.
- **Test first:** an edit whose queueing fails, or whose app is killed before queueing, is
  published on the next launch.
- **Effort:** M. **Risk:** medium; core publish path, covered by the existing outbox tests.

### C7-2 — Backups update the remote copy, never replace it (bug in the PWA, cross-client contract)

- **Proposal:** Adopt iOS's rule in the PWA's app backup:
  - read the latest remote backup and publish only after reading it (or confirming there is
    none);
  - build each publish from that copy updated with this device's changes;
  - keep the remote `walletSeed` when this device has none.

  Record the rule in `taskify-core`'s backup contract, with a test on each side.
- **Test first:** a device that starts offline and then changes a board does not drop another
  device's boards or the wallet seed.
- **Effort:** S–M. **Risk:** low. Recommended first, because the seed in the backup is what
  recovers funds after December 1.

### C7-3 — Shared vectors for the rules both clients implement (interop)

- **Proposal:** Add to `taskify-core/fixtures`, read by Node and Swift tests:
  - task event payloads (encode and decode, tombstones, unknown fields kept, Scripture Memory
    links, documents);
  - the app-state merges (Bible tracker, Scripture Memory, chat state);
  - the equal-timestamp rule. Both clients adopt NIP-01's: the lowest event id wins.

  Each client gains a vector test.
- **Effort:** M. **Risk:** low; the tie rule changes behaviour only on exact ties.

### C7-4 — iOS relinks Scripture Memory reviews (parity)

- **Proposal:** Port `relinkScriptureReviews`: an open review with no passage link, whose title
  names exactly one passage, is linked again in the reconcile and on receive. Covered by a C7-3
  vector.
- **Effort:** S. **Risk:** low.

### C7-5 — Split the iOS store (performance)

- **Proposal:** One file per area, each written only when it changed:
  - tasks, boards and events: the only file widgets and intents read;
  - chat;
  - inbox and contacts;
  - settings and sync state.

  Attachments become files referenced by name rather than inline data URLs. A one-time
  migration splits the existing file. A benchmark test records the cost before and after.
- **Effort:** M–L. **Risk:** medium; the migration must be safe to interrupt, and the widget
  path must stay in step.

### Recommended order

C7-2 (funds recovery, before December 1) → C7-1 (bug) → C7-4 → C7-3 → C7-5.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C7-1 | Approve | 2026-10-19 | Done (`89e18311`): `TaskPublishPlanner` in TaskifyCore stamps tasks and marks them `publishPending`, saved before encoding and signing; the mark clears only once the event is in the durable outbox. Pending tasks are published again after deferred startup, on reconnecting, and after a failure (5 s, 15 s, 1 min, 5 min) |
| C7-2 | Approve | 2026-10-19 | Done (`83fb1717`): the PWA publishes its app backup only after reading the remote copy, builds it from that copy (`updateRemoteNostrBackup` in core), keeps the remote seed when it has none, and retries a failed read after 60 s. Other devices' boards survive |
| C7-3 | Approve | 2026-10-19 | Done. Task event vectors in both directions (`2fc119d3`, documents in `98f1e597`); this found the PWA erasing iOS reminders on republish, now fixed by keeping fields it does not use (`syncExtras`). App-state merge vectors (`ce354267`): both clients already agreed. Tie rule (`f909aa5c`): at the same `created_at` the lowest event id wins, on both clients, through a shared `compareEventVersions` with vectors; each client records the id of the event it queued or received, and an edit not yet signed keeps a tie |
| C7-4 | Approve | 2026-10-19 | Done (`d06efc55`): iOS relinks an open review whose title names exactly one passage, in the Scripture Memory reconcile |
| C7-5 | Approve | 2026-10-19 | Done (`bd534cf7`): `taskify-store/` holds `tasks.json`, `chat.json` and `inbox.json`, plus content-addressed files for large inline attachments. A save writes only changed areas; widgets, intents and Siri load and write only tasks; widgets reload only when tasks change. The app splits a legacy store at load in an order that is safe to interrupt. Benchmark with 2,000 tasks and 5,000 messages, one task edit: 2.22 MB in 41 ms before, 0.57 MB in 18 ms after. Not yet checked on a device: the first launch after updating |

---

## Chunk 8 — iOS tasks, boards, Upcoming

The SwiftUI screens for boards (`Features/Boards`, 5,700 lines), tasks (`Features/Tasks`,
5,200) and Upcoming (`Features/Upcoming`, 4,000), with the root tab view and theme. Reviewed
against what chunk 3 changed on the PWA.

What the review found:

- **Much is already in good shape:**
  - performance work exists: lookup caches, a card text cache, coalesced completion taps, the
    `TASKIFY_PERF` on-device monitor and a scroll UI test;
  - the task card has VoiceOver labels and a context menu with every action;
  - the task screens carry no wallet code, and note Markdown already shares vectors with the
    PWA (C3-9).
- **Every board view redraws on any change, including a chat message.** `AppModel.snapshot` is
  one observed property, and board, card and Upcoming views read it through helpers such as
  `board(withID:)`, `tasks(for:)` and `runningStreak(for:)`. So any write re-runs every visible
  column and card body: a received message, a read marker or a contact update.

  Each write also invalidates the streak lookup. The first card to draw then rebuilds it over
  every task, which took **3.9 ms with 2,000 tasks** on an M-series Mac, more on a phone.
  Upcoming keys its whole filter cache on the same revision. Telling a chat change from a task
  change costs 0.015 ms.
- **The task editor reverts changes made elsewhere while it is open (confirmed by reading).**
  `persistChanges` writes every field from the state captured when the editor opened: title,
  note, due date, subtasks, reminders and attachments. Suppose a subtask is ticked on another
  device, or by the widget, while the editor is open. Saving the editor, even only to change the
  priority, unticks it again and publishes that. Completion is not affected, because the editor
  does not write it. The PWA editor should be checked for the same pattern.
- **"System" text size ignores the system (accessibility bug).** The app applies
  `.dynamicTypeSize(.large)` when the in-app scale is "System". The iPhone's own text-size
  setting, including the accessibility sizes, therefore never reaches the app. The largest
  in-app choice is `xxxLarge`, and 89 fonts in these screens use fixed point sizes that would not
  scale anyway.

  VoiceOver users can move a task between days or lists only through selection mode; a card has
  no "Move to…" action.
- **A new day does not move the screens to today (confirmed by reading).** Upcoming's selected
  date and the week board's focused column are set when the view first appears. Return to the
  app after midnight and Upcoming still shows yesterday as the selected day, and the week board
  stays on yesterday's column. This is the iOS form of the PWA's C3-2.
- **Events show no images or documents on iOS (parity).** The PWA attaches both to events.
  `TaskifyEvent` carries them on iOS, but the event card does not show them and the event editor
  cannot add or remove them. This joins the chunk 3 follow-up: the PWA stores event attachments
  inline.
- **iPad stretches board columns.** `boardColumnWidth` fills the width: about 300–470 pt per
  column on iPad, against 330 pt on iPhone. On the PWA desktop you asked that lists keep the
  phone width and that extra space show more lists instead.
- **`UpcomingView.swift` is 3,489 lines with five sheets inside.** It holds the event editor,
  the new-item sheet, the calendar and the cards, and its grouping runs on every body
  evaluation. Most of the logic is view-private, so it is out of reach of tests.
- **Language fit:** none. These are SwiftUI screens; the shared rules underneath already live in
  TaskifyCore and taskify-core.

### C8-1 — Views follow only what they show (performance)

- **User:** Everyone with chat activity or large boards, most of all during sync.
- **Proposal:** Observe by area, the areas of the C7-5 store:
  - `snapshot` stops being observed directly. Each area gets an observed revision (tasks and
    boards, chat, inbox), bumped only when that area changed;
  - every model accessor registers the area it reads, so a board view no longer depends on
    chat;
  - cards receive what they derive (streak, board key) from their column. They become
    `Equatable`, so an unchanged card skips its body when another task changes;
  - the streak lookup and the Upcoming cache key on the tasks revision.
- **Measure, don't assume:** with `TASKIFY_PERF`, count card bodies per received message on the
  140-task performance fixture, before and after. The expected result is that a chat message
  renders no card, and editing one task renders one card.
- **Effort:** M. **Risk:** medium; view invalidation must stay complete, so a missed area means
  a stale view (tests list each accessor's area).

### C8-2 — The editor saves only what the user changed (bug)

- **User:** Anyone using two devices, the widget or Siri while an editor is open.
- **Proposal:** Record the task as it was when the editor opened. On Save, apply only the
  fields the user changed to the current task: a pure `TaskEdit` in TaskifyCore, with tests.
  Untouched fields keep whatever arrived meanwhile. Check the PWA editors and apply the same
  rule there if they share the pattern.
- **Test first:** a subtask ticked elsewhere while the editor is open survives saving a
  priority change.
- **Effort:** S–M. **Risk:** low.

### C8-3 — Text size follows iOS; VoiceOver can move tasks (accessibility)

- **User:** Everyone who sets a larger or smaller text size, and VoiceOver users.
- **Proposal:**
  - "System" leaves Dynamic Type alone, and accessibility sizes are allowed. The in-app choices
    stay as overrides;
  - fixed-size fonts in these screens become text styles, or `@ScaledMetric` where a size must
    stay proportional (the complete button);
  - cards get a "Move to…" accessibility action that opens the existing move sheet.

  UI tests take screenshots at `accessibility3` on a board, the editor and Upcoming.
- **Test first:** a UI test that launches with a large content size category and finds the
  card title larger than at the default size.
- **Effort:** M (S for the "System" fix alone). **Risk:** low–medium; layouts must hold at
  large sizes.

### C8-4 — A new day moves the screens to today (bug)

- **User:** Everyone who leaves the app open overnight.
- **Proposal:** When the app becomes active or the day changes (`significantTimeChange`):
  - Upcoming moves its selected date to the new today, if it was on the old today;
  - the week board refocuses on today's column, unless the user moved away from today.

  The rule is a pure function in TaskifyCore with tests.
- **Test first:** with the clock moved past midnight, a selection on the old today moves to the
  new today; a selection on another day stays put.
- **Effort:** S. **Risk:** low.

### C8-5 — Event images and documents on iOS (parity)

- **User:** Anyone who attaches files to events on the PWA, or wants to on iOS.
- **Proposal:**
  - the event card shows the attachments, through the task card's media view made generic;
  - the event editor adds and removes them with the same encrypted upload service as tasks.

  This includes the chunk 3 follow-up: the PWA event editor uploads attachments instead of
  storing data URLs. Shared vectors cover an event with documents.
- **Effort:** M. **Risk:** low–medium (uploads, two clients).

### C8-6 — iPad keeps the phone's column width (layout consistency) — decision needed

- **Proposal:** Board columns are 330 pt on every width. Extra width shows more columns, as you
  asked for the PWA desktop.
- **Decision needed:** apply the desktop rule to iPad, or keep iPad's stretched columns.
- **Effort:** S. **Risk:** low.

### C8-7 — Upcoming in parts (architecture)

- **Proposal:**
  - the event editor, new-item sheet, calendar and cards move to their own files;
  - grouping and sorting move into TaskifyCore's `UpcomingTaskOrganizer`, with tests;
  - the grouped result is memoized on the tasks revision (after C8-1).

  This is behaviour-preserving, one commit per move.
- **Expected:** `UpcomingView.swift` drops to about 1,000 lines.
- **Effort:** M. **Risk:** low.

### Recommended order

C8-2 (data loss) → C8-4 (bug) → C8-3 (accessibility bug first, then fonts) → C8-1 → C8-7 →
C8-5 → C8-6 (if approved).

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C8-1 | | | |
| C8-2 | | | |
| C8-3 | | | |
| C8-4 | | | |
| C8-5 | | | |
| C8-6 | | | |
| C8-7 | | | |
