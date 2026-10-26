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
| 8 | iOS tasks, boards, Upcoming UI | `TaskifyApp/Features` (tasks side) | Done (2026-10-20) |
| 9 | iOS chat, settings, onboarding, wallet phase-out | `TaskifyApp/Features` (rest) | Done (2026-10-20); the App Store release must be live before Dec 1 |
| 10 | iOS extensions | Widgets, Watch, share extension, notification service, App Intents | Done (2026-10-20); C10-5 stages 2–3 and C10-2 stage 2 are deferred until after the December 1 wallet deletion and measurements |
| 11 | macOS | `taskify-macos` | Approved implementation done (2026-10-23); C11-6A/C11-7A signed proof gates in progress; shared wallet deletion remains due after Dec 1 |
| 12 | Nostr runtime and CLI | `taskify-runtime-nostr`, `taskify-cli` | Implementing (approved 2026-10-25) |
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
| C8-1 | Approve | 2026-10-20 | Done (`35396677`). The snapshot is stored outside observation, with one observed revision per area (tasks, chat, inbox). Board, card and Upcoming accessors read only the tasks area. Cards take their streak and board key from their column and are `Equatable`. Measured with `BoardRenderUITests` on the 140-task fixture: 20 chat writes re-rendered 1,200 cards before and 0 after; one task edit re-rendered 60 before and 1 after |
| C8-2 | Approve | 2026-10-20 | Done (`a0e334e4`), on both clients. TaskifyCore `TaskEditorFields` and core `mergeTaskEdit` apply only the fields the user changed. The schedule, reminders and attachments move as groups, and subtasks merge item by item. The PWA editor had the same bug and passes the task as it opened |
| C8-3 | Approve | 2026-10-20 | Done (`a07d26e6`). "System" follows the iPhone's text size, accessibility sizes included. 70 fixed sizes now scale through `.scaledFont`, which is identical at the default size. Cards have a "Move to…" VoiceOver action and context-menu item. `DynamicTypeUITests` checks that titles grow and saves screenshots at AX3 |
| C8-4 | Approve | 2026-10-20 | Done (`d327ed5c`). `DayRollover` (tested) and `.onNewDay` move a selection on the old today to the new today. Not exercised live: the simulator clock can't be moved |
| C8-5 | Approve | 2026-10-20 | Done (`83227608`). iOS event cards show the image and documents. The event editor removes them and adds photos or files through the encrypted upload. Calendar event vectors cover both directions, and `EventAttachmentUITests` checks the card and editor. The chunk 3 follow-up needed no change: since `fb0341a1` the PWA uploads event attachments at publish and sends links |
| C8-6 | Approve; phone width on iPad | 2026-10-20 | Done (`d9b41dc9`). Columns are 330 pt on every screen, and the focused column anchors at the leading edge. Checked by screenshots on iPad and iPhone |
| C8-7 | Approve | 2026-10-20 | Done (`9ff48526`). `UpcomingView.swift` went from 3,489 to 1,167 lines, with the calendar, cards, sort sheet, new-item sheet and event editor in their own files. Day grouping is `UpcomingTaskOrganizer.tasksByDay` (tested) and memoized on the tasks revision. The split and the grouping are one commit, not one per move |

**Found while verifying:** 14 of the 71 iOS UI tests fail on a clean install at the commit before chunk 8 too. They are pre-existing, not caused by this chunk: six Bible tracker, fasting and relay tests, three wallet keypad sheets, onboarding sign-in, selection bulk delete, the event time zone check and two scroll tests. Several also depend on what earlier tests left in the simulator. They need their own pass.

---

## Chunk 9 — iOS chat, settings, onboarding, wallet phase-out

The rest of the iOS app:
- the wallet (17,000 lines: 6,900 in TaskifyCore, 10,400 in the app);
- chat and contacts (8,400);
- settings and onboarding (4,000).

The wallet comes first because of the fixed date. The PWA has been withdraw-only since chunk 6,
and switches to recovery by itself on December 1, 2026. iOS must follow the same policy, and an
App Store release has to be live before that date.

What the review found:

- **The iOS wallet is at the first stage of the phase-out only.** It is hidden on devices that
  never used it. A one-time notice goes to users with a balance, and a close-out returns an
  emptied wallet to the no-wallet state. That matches what the PWA had before chunk 6.

  Still on iOS, all removed from the PWA in C6-1:
  - **Receive:** Lightning invoices, pasted or scanned ecash, and payment requests, including
    the Nostr payment inbox.
  - **Lightning addresses:** the npub.cash address manager, and a sheet that sells a custom
    solife address.
  - **Moving money between mints:** mint transfers and swaps.
  - **The notice:** it asks users to move funds "immediately" and names no date.

  There is no recovery view, and nothing switches off on December 1.
- **The stuck-token bug the PWA had is also on iOS (confirmed by reading).** On devices that
  redeem manually, and in NWC mode, received tokens are saved unredeemed. Every saved token blocks
  close-out ("Received ecash is still waiting to be redeemed"). A token already redeemed in
  another wallet is removed only in auto-redeem mode, or if the user finds it in the Receive
  screens and discards it. The close-out card names the blocker but offers no way to clear it.
  Once Receive goes, nothing could clear it. This is the case fixed on the PWA in `262f17ab`.
- **Chat is already wallet-free.** A received Cashu token is copy-only, and chat has no payment
  flows.
- **An open conversation rebuilds on every task change (measured).** The conversation memoizes
  its timeline on `snapshotRevision`, which every write bumps. With the 300-message chat fixture
  open, 20 task writes rebuilt the timeline 20 times, about 1.6 ms each on the simulator, plus the
  view diffing. During a sync burst this repeats for every merged batch. This is the chat side of
  C8-1, which scoped boards and cards to the tasks area.
- **First run still starts with keys.** Onboarding offers "Sign in with nsec" or "Create new
  login". It shows the private key to copy, then asks for notification permission before the
  user has a reminder. C2-5 changed the PWA to "Start using Taskify", with key backup and
  permission asked later. iOS was left for this chunk. The onboarding sign-in UI test already
  fails on a clean install (see chunk 8).
- **Settings shows a porting checklist to everyone.** "Native app status" lists 15 features as
  "Active" with green checks. All but two are hard-coded, and "Wallet: Active" is now wrong.
  Two wallet cards in `SettingsView` ("Wallet currency" and "Recipient keys", about 120 lines)
  are defined but never shown.
- **Language fit:** none. This chunk mostly removes code; the chat fix reuses C8-1.

### C9-1 — Withdraw-only iOS wallet with one "Move funds out" path (parity with C6-1)

- **User:** Everyone with a Taskify wallet on iOS.
- **Proposal:** The same policy as the PWA:
  - "Move funds out" replaces Receive. It covers:
    - Lightning out;
    - one ecash token per mint, recorded in History so an unclaimed token can be taken back;
    - NWC sweep;
    - npub.cash claims for funds already owed;
    - the 12 words.
  - Receiving, payment requests, the Lightning address manager, the solife address sale, mint
    transfers and swaps are removed. A scanned token is copied, not redeemed.
  - The notice names December 1, 2026 and shows once more.
- **Test first:** with funds, the wallet offers only ways out. The UI tests for the keypad
  sheets, which already fail, are replaced by move-out tests.
- **Effort:** M. **Risk:** medium; funds must stay reachable (tested per path).
- **Decision needed:** existing solife address owners keep their address until it expires, with
  no new sales. Or the sheet goes entirely.

### C9-2 — December 1: a recovery view instead of the wallet (parity with C6-2)

- **Proposal:** From local midnight on December 1, 2026 the full wallet is off on iOS too.
  Devices that had it get a recovery view that reads storage only. Like the PWA's, it shows:
  - each mint's notes as a token;
  - saved and unclaimed sent tokens;
  - the 12 words with their mints.

  A hidden switch previews it, as on the PWA. TaskifyCore gains the date and the token export
  from stored proofs, with tests.
- **Effort:** M. **Risk:** medium. **The App Store release must be live before December 1**,
  so this goes into the next beta.

### C9-3 — Close-out clears saved tokens (bug, parity with `262f17ab`)

- **Proposal:** Close-out checks saved and inbox tokens with their mints (NUT-07). Spent ones
  are removed, with a copy kept in History. One that cannot be checked can be removed by the
  user from the close-out card, which lists each token with Copy and Remove.
- **Test first:** a saved token already redeemed in another wallet no longer blocks close-out,
  on a manual-redeem device and in NWC mode.
- **Effort:** S–M. **Risk:** low; nothing is removed while a mint says it is unspent.

### C9-4 — Chat follows chat state (performance)

- **Proposal:** The C8-1 pattern for chat:
  - chat accessors read only the chat area (messages, groups, read state) and the inbox area
    (contacts, shared items);
  - the conversation timeline and the chat list memoize on those revisions.
- **Measure:** the chat probe and `ChatRenderUITests` were written for this review. They are
  kept as a patch and become the regression test. Today 20 task writes cause 20 rebuilds; the
  target is 0.
- **Effort:** S–M. **Risk:** low–medium; the same care as C8-1 (complete invalidation).

### C9-5 — First run that starts with tasks (parity with C2-5)

- **Proposal:** iOS onboarding follows the PWA:
  - "Start using Taskify" creates the key silently and opens a starter board;
  - "I already use Taskify" holds sign-in and restore;
  - key backup is asked for once the user has something to lose, with an "Unsaved key" reminder
    in Settings;
  - notification permission is asked at the first reminder.

  The onboarding UI tests are rewritten for the new order.
- **Effort:** M. **Risk:** low.

### C9-6 — Settings without the porting checklist (cleanup)

- **Proposal:** Remove "Native app status". The one live status, Nostr sync, already has its
  own card. Delete the two unused wallet cards. Wallet settings stay inside the wallet.
- **Effort:** S. **Risk:** low.

### Recommended order

C9-3 (stuck funds) → C9-1 → C9-2 (must ship before December 1) → C9-4 → C9-6 → C9-5. Then an
iOS beta build, so the phase-out reaches the App Store in time.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C9-1 | Approve; remove the solife sale entirely | 2026-10-20 | Done (`6f1cbd1b`). "Move funds out" replaces Receive. It offers Lightning out, an ecash token, a move to the NWC wallet, npub.cash claims, saved tokens to copy, and the 12 words, and names December 1, 2026 (`TaskifyWalletPhaseOut`, tested). Removed: receiving, payment requests, scanning to redeem, the setup card, adding mints, mint transfers, NWC → ecash swaps, the Lightning address manager, the solife sale, recipient keys and NWC receive (about 2,700 lines). Incoming tokens are saved, never redeemed. The notice (v2) names the date. **Found and fixed:** a DEBUG-only update loop with `TASKIFY_UI_TEST_WALLET` kept the app busy, which is why every wallet UI test timed out. `WalletMoveFundsOutUITests` replaces the keypad tests |
| C9-2 | Approve | 2026-10-20 | Done (`72d31c4e`). From local midnight on December 1 (or with the hidden launch argument `-TaskifyWalletRemovalPreview YES`), the wallet service stops starting and the tab shows `WalletRecoveryView`. It shows each mint's unspent and in-flight notes as one V3 token, read straight from the CDK database with no network and no writes, plus saved and unclaimed sent tokens and the 12 words behind device authentication. Tested with a real CDK database and a UI preview |
| C9-3 | Approve | 2026-10-20 | Done (`5a99619f`). TaskifyCore `CashuNUT07` implements hash_to_curve (spec vectors) and checkstate for any mint; the request shape was checked against a live mint. Close-out removes saved tokens that were spent elsewhere, keeping a copy in History, and lets the user remove ones that cannot be checked. Tokens that still hold funds block close-out until moved out. The card itself was not exercised with real funds |
| C9-4 | Approve | 2026-10-20 | Done (`bb0e1469`). Chat accessors read the chat area, the inbox area, or both. The conversation keys its memo on `conversationRevision`. `ChatRenderUITests`: 20 task writes caused 20 timeline rebuilds before and 0 after |
| C9-5 | Approve | 2026-10-20 | Done (`40bb82d5`). Onboarding offers "Start using Taskify" or "I already use Taskify". `KeyBackupState` uses the PWA's thresholds; a banner shows on Boards and "Unsaved key" in Settings. Reminders already request permission when first set. The invalid-key UI test failed because a tap on Sign in while the keyboard moved in could miss; Return now signs in (`c58b4fb6`) and the test passes |
| C9-6 | Approve | 2026-10-20 | Done (`0160d89e`). "Native app status" and the two unused wallet cards are removed (247 lines) |

**Next for the wallet:** iOS build 173, carrying C9-1 to C9-3, was uploaded to App Store Connect on
October 20, 2026 (`fb8c1124`). It must be released to the App Store before December 1, 2026.
macOS follows in chunk 11.

**UI tests (after chunk 9):** the iOS UI suite passes on a clean install, with 74 tests and 8
skipped. The failures came from state left by earlier tests and from tests that no longer matched
the UI:
- the Bible tests start from a fresh store (`634236db`);
- the task editor puts the keyboard away on scroll (`99235115`);
- Return signs in (`c58b4fb6`);
- tests updated to the current UI (`dbc3b8ac`).

---

## Chunk 10 — iOS extensions

Everything that runs outside the iOS app's main screens:

| Part | Lines |
| --- | --- |
| Watch app | 7,600 |
| `TaskifyWatchShared` (Watch models and Nostr code) | 3,600 |
| Watch complications | 330 |
| Watch bridge on the iPhone | 680 |
| Widgets: Today, Upcoming, Lock Screen, Board, and the New Task control | 1,100 |
| App Intents and Siri (Add Task, Quick Add, the reminders schema) | 790 |
| Share extension | 630 |
| Notification service | 150 |

Several parts edit tasks without the app running:
- the widget's checkbox;
- Siri and Shortcuts;
- the Watch, when it is away from the iPhone.

Most findings are about those edits.

What the review found:

- **A widget tap can reopen a finished task (bug, confirmed by reading).** `CompleteTaskIntent`
  calls `toggleCompletion` and does not check the task's current state. Say a task is completed
  on another device, or in the app, after the widget last drew. Ticking the stale row then marks
  it open again.
- **Completions made outside the app ignore the user's settings.** The widget and the Siri
  update intent call `toggleCompletion` with its defaults:
  - streaks are counted even when the user turned them off;
  - the week starts on the default day, not the user's choice (used for weekly next occurrences);
  - `completedBy` / `lastEditedBy` is not set.

  The in-app path passes all three. It also reconciles Scripture Memory before anything is
  published. `absorbExternalStoreChanges` does not run that step when the app later picks up an
  outside completion.
- **Edits made outside the app stay on this iPhone until the app runs.** The widget's checkbox and
  Siri "Add Task" write the shared store and stop. Nothing reaches the relays until one of these
  happens:
  - the app comes to the foreground;
  - iOS grants a background refresh.

  That can take hours, and the PWA, the Mac and the Watch show the old state until then. The
  app's outbox (`NostrOutboxStore`) is in the app's private container, so an extension cannot add
  to it.
- **The Watch ends a recurring series when it completes a task away from the iPhone (bug,
  confirmed by reading).** This is the C1-1 bug on the Watch. When the iPhone is out of reach, the
  Watch publishes the completion itself (`directMutations`, `.completeTask`). It only sets
  `completedAt` and `status: done`. The rule every client follows is that the completing client
  creates the next occurrence, and the Watch can't, because it has no recurrence code.

  The command it queues for the iPhone doesn't repair this. `completeTasksFromWatch` skips tasks
  that are already completed. The iPhone usually hears the Watch's relay event before the queued
  command arrives, so it sees a completed task and creates nothing.
- **The Watch has a second copy of the protocol.** `TaskifyWatchShared` has its own copies of
  NIP-44, NIP-17 gift wraps, board encryption, event signing and task payloads, plus Watch-only
  models. They exist because TaskifyCore can't build for watchOS. Its only watchOS blockers are
  the wallet's two dependencies, CDK and URKit; nothing else in its 33,000 lines (26,000 without
  the wallet) needs iOS. NIP-44 is cross-tested against core, but the task payloads and
  completion rules are not. That is how the recurrence bug above got in.
- **Extensions load more than they show.**
  - The notification service loads every store area (all tasks, all messages, all contacts) to
    decide a DM preview. That decision needs only the chat and inbox areas.
  - The widgets load the tasks area.
  - Every load reads each externalized attachment back into memory as an inline data URL.
    Nothing in the widgets or the notification service shows one.

  iOS limits a notification service to about 24 MB and a widget to about 30 MB. A store with a
  few large images can push either over the limit:
  - the preview falls back to the generic alert;
  - the widget renders blank.

  This was not measured on a device; the proposal below measures it first.
- **The share sheet can only send to a chat.** Sharing a link, text or photo into Taskify always
  goes to a conversation. There is no "save as a task", which is the most common share-sheet use
  for a task app. The PWA has no share target either.
- **Tasks aren't in Spotlight.** No `IndexedEntity` and no Core Spotlight items. The Siri reminders
  schema can update and complete tasks, but a user can't search for one from the Home Screen.
- **What works well and stays:**
  - the App Intents live in the app target, with the reasons documented;
  - the New Task control is compiled into both targets;
  - widget reloads are debounced and fire only on task saves;
  - the notification service drops action keys a push cannot be trusted with;
  - the share extension's background uploads are resumable;
  - the Watch complications read a small cache of their own.

  The Watch also has chat, about 5,000 lines, which is more than the "nothing else" in the table
  above. It works and is tested; C10-5 shrinks what it duplicates. No change is proposed.
- **Language fit:** no new language. The duplication is Swift against Swift. One Swift core on
  the Watch (C10-5) removes it, which is the gain a Rust core (C1-6) would bring here.

### C10-1 — One action layer for edits made outside the app (bug)

- **User:** Everyone using widgets, Siri or Shortcuts.
- **Proposal:** TaskifyCore gets `TaskifyExternalActions`, the one path for every edit made out
  of process:
  - **Actions:** complete, add and update. Complete is idempotent: it never reopens a task, and
    it does nothing for a task that is already done or deleted.
  - **Settings:** the actions read the user's streak setting, week start, new-task position and
    public key from the App Group. The app writes these whenever they change.
  - **Callers:** the widget checkbox, Siri Add/Quick Add and the reminders schema all use it. Siri
    keeps its explicit "mark incomplete".
  - **Pickup:** when the app reads in outside changes, it runs the same steps as an in-app
    completion: Scripture Memory reconciliation, notifications and publishing.
- **Test first:**
  - a widget completion of a task already completed in the store leaves it completed;
  - a completion with streaks off records no streak;
  - a weekly task completed through the action layer gets the same next occurrence as one
    completed in the app.
- **Effort:** S–M. **Risk:** low.

### C10-2 — The Watch keeps recurring series going (bug, parity with C1-1)

- **User:** Watch users with recurring tasks, and everyone sharing those boards.
- **Proposal:** Two stages.
  1. **Now:** when the iPhone processes the Watch's completion command, it makes sure the next
     occurrence exists, even if the task is already completed. Instance ids come from the date,
     so this is idempotent, and a second device converges on the same id.
  2. **With C10-5:** the Watch completes through core's `toggleCompletion` and publishes the
     next occurrence itself. Then the series continues even if the iPhone never comes back.
- **Test first:** a recurring task completed by a Watch event, followed by the Watch's command,
  ends with exactly one next occurrence. Today it ends with none.
- **Effort:** S (stage 1). **Risk:** low.

### C10-3 — Extensions load only what they show (reliability)

- **Proposal:**
  - `JSONTaskStore.load` gets a read-only mode that keeps attachments as references and never
    reads them.
  - The notification service loads only the chat and inbox areas, in that mode.
  - The widget timelines use the same mode for the tasks area.
  - Saves from extensions keep today's full load, since they write back.
- **Measure first:** the peak memory of the preview decision and of a widget timeline, with a
  store holding 20 MB of task images. Record the before and after in the report.
- **Effort:** S. **Risk:** low.

### C10-4 — Outside edits reach the relays at once (sync)

- **User:** Anyone who ticks a task off in a widget or adds one with Siri, then looks at another
  device.
- **Proposal:**
  - The outbox moves to the App Group. The app moves the existing file on first launch.
  - `TaskifyExternalActions` (C10-1) adds each edit's events to it.
  - The intent then tries to publish right away, within a few seconds. Board events are signed
    with the board key, so the extension needs no user key.
  - The app's sync engine sends whatever is left, as it does today.
  - The store and the outbox are written under a file lock, so the app and an extension never
    interleave.
- **Test first:** an event added to the outbox by a second process is published by the app's
  engine exactly once. A widget completion is visible on a relay before the app is opened (UI
  test with a local relay).
- **Effort:** M–L. **Risk:** medium. Two processes share one outbox, and proof-of-work relays may
  need more time than an intent gets; those events wait for the app, as now.

### C10-5 — One Swift core on the Watch (architecture, interop)

- **Proposal:**
  - Move the wallet out of TaskifyCore into its own `TaskifyWallet` target, which only the iOS
    and macOS apps link. After December 1 that target is deleted anyway.
  - TaskifyCore then builds for watchOS.
  - The Watch uses core's models, task codec, recurrence, encryption and gift wraps.
  - `TaskifyWatchShared` keeps only the Watch's caches and its transfer types. The duplicate
    protocol code goes, an estimated 1,500–2,000 lines.

  The Watch then follows the cross-client vectors (C1-2, C7-3) by construction.
- **Measure:** Watch app binary size and launch memory, before and after. Stop if either grows by
  more than 20%.
- **Effort:** L. **Risk:** medium. Do it in stages: the wallet target, then crypto, then tasks.

### C10-6 — Save to Taskify from the share sheet (UX)

- **User:** iPhone and iPad users capturing links, text and photos.
- **Proposal:** The share extension gets a "New task" destination above the chats:
  - the title comes from the page title or the first line of text;
  - a link goes in the note;
  - images go in as task images (C8-5);
  - the board is chosen like the Add Task intent's.

  It writes through C10-1, and through C10-4 once that lands.
- **Effort:** M. **Risk:** low.

### C10-7 — Tasks in Spotlight (UX)

- **Proposal:** The Siri reminder entity becomes an `IndexedEntity`. The app indexes open tasks
  (title, board, due date) and updates the index when it saves. Spotlight finds a task, and opening
  it shows the task in the app. Completed and deleted tasks leave the index.
- **Effort:** S–M. **Risk:** low. The index stays on the device.

### Recommended order

C10-1 → C10-2 → C10-3 (bugs and limits first) → C10-4 (builds on C10-1) → C10-6 → C10-5 (wallet
target first; the rest can wait for the December 1 deletion) → C10-7.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C10-1 | Approve ("Continue") | 2026-10-20 | Done (`bb60d4ce`). `TaskifyExternalActions` is the one path for edits made outside the app. Completion is idempotent, so a stale widget row no longer reopens a task. It uses `TaskifyDeviceTaskSettings` (streaks, week start, new-task position, the account), which the app mirrors to the App Group whenever they change; Siri's Add Task uses the same settings. When the app picks up outside changes it reconciles Scripture Memory first |
| C10-2 | Approve | 2026-10-20 | Stage 1 done (`3604a0a1`). `ensureNextRecurrence` creates the next occurrence of a completed task when it is missing (idempotent, date-derived id; a deleted occurrence stays deleted). The iPhone calls it for Watch completions that arrived before the Watch's command. Stage 2 waits for C10-5 |
| C10-3 | Approve | 2026-10-20 | Done (`51331334`). `JSONTaskStore.read(areas:)` reads for display and leaves attachments on disk. Widget timelines read the tasks area; the notification service reads only chat and inbox. Measured with 20 MB of task images: a load grew the footprint by 19 MB, a read by 0 MB. Not checked on a device |
| C10-4 | Approve | 2026-10-20 | Done (`ca2d2a52`), with a simpler design than proposed. The store's existing publish-pending marks (C7-1) are the durable record instead of an outbox shared through the App Group, so no two processes share an outbox. `TaskifyExternalActions.commit` stamps and saves first, then `TaskifyExternalPublisher` tries each board's relays for up to 6 s and clears the mark only for events every relay accepted. The app sends anything left at launch and when it picks up the change. Tested with a fake sender and a local WebSocket relay; not yet tried against the production relays from a real widget. A relay that asks for authentication is left to the app |
| C10-5 | Approve | 2026-10-20 | Stage 1 done (`d9922120`). The wallet is the `TaskifyWallet` target, linked only by the iPhone and Mac apps, and TaskifyCore builds for watchOS. Chat's token detection moved to core (`CashuTokenText`). Stages 2–3 (the Watch using core's crypto, then its task code) are not started: they need the binary-size and memory measurement first, and can follow the December 1 deletion |
| C10-6 | Approve; hand-off design (maintainer: "do what you recommend") | 2026-10-20 | Done (`6e9dd98a`, foundation `b9a9899e`). The share extension stays isolated: it writes a `ShareTaskDraft` to its own App Group, and the app imports it at launch, on becoming active and in background refresh. Safari omits `attributedTitle`, so the extension fetches link metadata and keeps the URL fallback. The two-test UI suite shares example.com and verifies the "Example Domain" task, then imports a real PNG draft through the configured media server and verifies the encrypted attachment. That photo test first exposed the removed Originless `/upload` route; `3bba2693` moved PWA, CLI and Swift to `/up`, with shared core helpers and JSON vectors |
| C10-7 | Approve | 2026-10-20 | Done (`d55370e9`). Open tasks on boards that aren't archived are in Spotlight with their board and due date, and leave it when completed or deleted. Each save sends only what changed (`TaskifySpotlightIndex`). A result opens the task's editor. `SpotlightUITests` finds a new task from the Home Screen and opens it |

### Checkpoint — October 20, 2026 (chunk complete)

Everything is committed on Beta. Nothing is pushed: the maintainer pushes.

**Done in chunk 10:**
- C10-1 (`bb60d4ce`), C10-2 stage 1 (`3604a0a1`), C10-3 (`51331334`) and C10-4 (`ca2d2a52`);
- C10-5 stage 1 (`d9922120`): the wallet is the `TaskifyWallet` target. App, Mac and test files
  that use wallet types need `import TaskifyWallet`;
- C10-6 (`6e9dd98a`, foundation `b9a9899e`): links, text and images can be saved as tasks from
  the share sheet. `ShareToTaskUITests` passes both the Safari page flow and the real encrypted
  image-upload/import flow. The upload flow found and fixed the stale Originless endpoint in all
  clients (`3bba2693`), guarded by `file-server-upload-vectors.json` in Node and Swift;
- C10-7 (`d55370e9`).

iOS build 173 is uploaded to App Store Connect. It must be released to the App Store before
December 1, 2026.

**Deferred follow-up:**
- C10-5 stages 2–3 (the Watch uses core): measure Watch binary size and memory first, after the
  December 1 wallet deletion.
- C10-2 stage 2 depends on them.
- On a device: widget taps, relay publishing from an intent, memory saved in the notification
  service, and Spotlight. None of these has been tried yet.

Chunk 11 (macOS) is next. Review and bring C11-n proposals before implementation. Its Mac wallet
phase-out must follow iOS's December 1 date.

---

## Chunk 11 — macOS

The native Mac client is a real SwiftUI/AppKit application, not Catalyst. It is about 5,100 lines
of Mac source and compiles selected iOS application services directly beside `TaskifyCore` and
`TaskifyWallet`. Its desktop foundation is stronger than the old port checklist suggests:
multi-window navigation, week/list/compound boards, a sortable task table, task and event editors,
Today/Upcoming, EventKit, chat and groups, the shared inbox, contacts, encrypted attachments,
printing, devotional tools, settings, relays and offline publication all exist. Task mutations,
recurrence, sync, encryption and wire formats already go through the same Swift core and `AppModel`
as iOS; no separate Mac protocol implementation should be introduced.

What the review found:

- **The Mac app does not build at the current Beta head.** Its 14 presentation tests pass, but the
  package target compiles only four small files under `Sources/Presentation`. The real app target
  fails because the shared `TaskNoteViews.swift` now uses `ScaledSize` / `.scaledFont`, while
  `DesignSystem/ScaledFont.swift` is not in the Mac project's shared-file list. `AppModel.swift`
  also calls `runPerformanceProbeIfRequested()`, while `AppModelPerfProbe.swift` is absent. Both
  arrived in the iOS chunk after the last successful Mac build.
- **The project generator is no longer its own source of truth.** The committed project was patched
  in C10-5 to add `TaskifyWallet` and `WalletKeychainStores.swift`; `generate-project.py` contains
  neither. Running the documented generator would erase those fixes, and still would not add the
  two files above. The README currently claims deterministic regeneration and a clean build, which
  is no longer true.
- **CI compiles no Swift at all.** `.github/workflows/ci.yml` says so explicitly. The October 2
  audit already recommended an unsigned Mac build and Swift tests on a macOS runner; this failure
  is the exact regression that gate would have caught.
- **The Mac wallet is still the pre-phase-out product.** About 1,700 Mac-specific lines expose
  Receive, add/remove mint, mint transfer, payment-request creation/payment, NWC receive and
  NWC↔ecash moves. `MacRuntime.start()` starts `WalletViewModel` on every ordinary launch. Although
  the shared `WalletPhaseOut` knows the December 1 recovery date, `MacWorkspace` always renders
  `MacWalletView`; it neither stops the wallet service nor shows recovery. Without a Mac release,
  December 1 would close the PWA and iOS wallets while the Mac continues accepting funds.
- **The app UI has no automated coverage.** The presentation tests do not launch the app. The old
  preview smoke method is intentionally retired in the README because its development build shares
  the production bundle id and Keychain-backed identity; preview mode isolates the JSON store but
  not identity. Important desktop-only guarantees (multi-window account reset, quit-save, stale
  editor protection, drag/drop, paste, deep links and sandbox access) are therefore assertions by
  reading or old manual notes, not regressions a test can catch.
- **Spotlight stops at iOS even though the Mac is ready for it.** `TaskifySpotlightIndex` is already
  platform-neutral, and the Mac already parses the same `taskify://task` links. Only the indexer
  call is guarded to iOS and its source is absent from the Mac target.
- **One normal Mac attachment path is missing.** Finder file copy/paste and drag/drop work. Browser
  “Copy Image” data without a backing file does not, because both composers accept only
  `Transferable` URLs. The README correctly refuses to call a data-transfer implementation done
  without a launched UI test.
- **Several checklist gaps are phone concepts, not Mac defects.** The Mac's explicit “Show
  Completed” checkbox is clearer in a dense board than iOS's global completed-tab mode. Per-window
  `SceneStorage` restoration is more useful than one fixed startup tab. The sidebar/table replace
  the list-index card, and camera scan-back-in does not belong on a desktop without a camera flow.
- **Closed-app chat push is honestly disabled.** The coordinator rejects Mac registration rather
  than sending a Mac token to the iOS APNs topic. Supporting it needs a separate topic,
  entitlements, push-relay contract and end-to-end device verification; it is not a local UI port.
- **Language fit:** no new language. Mac and iOS already share Swift behavior directly. Rust/WASM
  would add a bridge without removing an implementation here; the useful simplification is to make
  the existing Swift target boundary and build gate reliable.

### C11-1 — Reproducible Mac project and a CI build gate — recommend **Approve**

- **User:** Every Mac user; this is currently a release blocker.
- **Proposal:**
  1. Add a generator `--check` mode that renders in memory and fails when the committed project is
     stale. Keep one declarative manifest for shared source files and Swift package products.
  2. Restore the current build by including the support files the shared app sources actually use,
     including `ScaledFont.swift`, `AppModelPerfProbe.swift`, `WalletKeychainStores.swift` and the
     `TaskifyWallet` product. Regeneration must produce no diff.
  3. Add a macOS CI job that runs generator check, Mac presentation tests in a temporary scratch
     path, and the unsigned `Local` app build in temporary derived data. This is the first stage of
     the broader Swift CI job already proposed in the full-stack audit.
  4. Update the README's generated-file and validation claims from the commands' actual results.
- **Test first:** the current app build is the failing regression. A generator test also proves that
  omitting a source/product makes `--check` fail before Xcode runs.
- **Effort:** S–M. **Risk:** low.

### C11-2 — The same wallet end state on Mac — recommend **Approve**

- **User:** Anyone who ever used the Taskify wallet on a Mac. This must ship before December 1.
- **Proposal:** Follow C6 and C9, without adding a Mac-only wallet policy:
  - now, replace the full Mac wallet with the same withdraw-only “Move funds out” paths and wording
    as iOS; remove Receive, payment requests, new mints, mint transfers, NWC receive, NWC→ecash and
    the other ways to bring money in;
  - from local midnight on December 1 (and under the same hidden preview switch), do not start the
    wallet service. Show a read-only recovery view for stored proofs, saved/unclaimed tokens and
    the 12 words;
  - after the date, delete the Mac wallet screens and stop linking `TaskifyWallet` when the shared
    iOS recovery deletion happens. Keep the small recovery path under Account/Backup until its
    separate removal decision.
- **Tests first:** a Mac UI test with the removal preview must show Recovery and no Receive action;
  a runtime test must show that recovery mode never calls wallet start. Existing `TaskifyWallet`
  tests remain the authority for token export and close-out semantics.
- **Effort:** M before the date; a large code deletion after it. **Risk:** medium because funds must
  remain recoverable. Do not exercise real funds in automation.

### C11-3 — An isolated Mac UI-test host for desktop guarantees — recommend **Approve**

- **User:** Mac users, especially people with multiple windows or offline edits.
- **Proposal:** Add a UI-test configuration with a different bundle id, a temporary store/outbox,
  a throwaway Keychain namespace and no production relays or wallet startup. Build the fixture
  injection into dependencies rather than process-global `setenv` calls. Start with:
  - launch/onboard, create/edit/complete a task and reopen it through a deep link;
  - stale editor conflict and account-switch reset with two windows;
  - quit after an edit persists locally, and a publish-pending edit survives an offline relaunch;
  - file drop/paste and the wallet-recovery preview needed by C11-2.

  Keep signed sandbox/Keychain, print, EventKit and real cross-client relay checks as a separate
  release checklist; a UI fixture cannot prove provisioning.
- **Effort:** M. **Risk:** low. Stage 1 is the isolated host plus the wallet/deep-link smoke tests;
  add the rest one behavior at a time.

### C11-4 — Open Mac tasks in Spotlight — recommend **Approve**

- **User:** Desktop users finding a task without first navigating Taskify.
- **Proposal:** Compile the existing `TaskifySpotlightIndexer` on macOS, run it after task-area
  saves as iOS does, and attach the shared `taskify://task` content link. Open results in the right
  board with the task selected/inspected. Completed, deleted and archived-board tasks leave the
  index by the same `TaskifyCore` rules and tests as iOS.
- **Test first:** in the isolated host, index a fixture task, open its searchable item, and assert
  the Mac selects that task; completing it removes the item.
- **Effort:** S. **Risk:** low; the index remains local.

### C11-5 — Paste copied image data as an attachment — recommend **Approve**

- **User:** People collecting a browser screenshot/image into a task or chat.
- **Proposal:** Give `MacAttachmentQueue` one import boundary for file URLs and raw transferable
  image data. Materialize raw data into the attachment directory with a safe generated name and
  detected type, then use the existing encrypt/upload path; do not add a second upload format.
  Use it from both the task editor and chat composer.
- **Test first:** put PNG data with no file URL on the isolated test pasteboard, paste it into each
  composer, and assert the staged attachment and encrypted upload input. Keep the existing file-URL
  path covered too.
- **Effort:** S–M. **Risk:** low, but runtime type negotiation is why the UI test is required.

### C11-6 — Capture when the main window is not frontmost — recommend **Explore**

- **User:** Desktop power users capturing work from another app.
- **Question:** Which native surface earns its permanent cost: a small menu-bar quick-add,
  Shortcuts/App Intents, a macOS Share extension/Services item, or a combination backed by one
  `TaskifyExternalActions` call? A global hotkey alone brings conflicts and Accessibility concerns.
- **Exploration:** prototype the smallest menu-bar and Shortcuts paths against the isolated store,
  measure launch time and packaged size, and verify that an out-of-process addition is saved and
  marked for publication exactly like C10-1/C10-4. Return with one concrete proposal; do not port
  the entire iOS extension graph by checklist.
- **Effort:** S to explore, M–L to ship. **Risk:** medium (extension storage and signing).

#### Exploration result — October 23, 2026

Two compile-only prototypes used the current `Local` app and were removed afterwards:

- A `MenuBarExtra` with one task-name field called the existing `AppModel` quick-add path. It
  built and added about 40 KB to the 151,368 KB Local product. The size is not its real cost: the
  full app, task model, deferred services and (until the scheduled deletion) wallet remain a
  resident process. It works when the main window is behind another app, but not while Taskify is
  closed.
- The existing iOS `TaskifyAddTaskIntent` plus a Mac `AppShortcutsProvider` built unchanged for
  macOS. Xcode emitted discoverable Add Task and Quick Add Task metadata and both phrase sets. The
  Local product was 151,560 KB, 192 KB above the same baseline; `Metadata.appintents` itself was
  6,845 bytes. This surface has no permanently resident UI and is available through Shortcuts,
  Siri and system search.

The prototype deliberately was not invoked. `TaskifyIntentTaskWriter` constructs
`JSONTaskStore()` internally, while the isolated Mac host injects a session store into
`AppModel`; invoking the unsigned prototype could therefore have written the production store.
The existing `ExternalPublishTests` prove that the underlying external-action boundary saves a
mutation and its pending-publication mark before trying the network, but they do not prove that
macOS launches the intent in the expected signed sandbox or container. That missing seam is the
first production task, not something to bypass in an exploration.

##### C11-6A — Add Task through Mac Shortcuts — recommend **Approve**

- Move the add-task mutation into an injectable `TaskifyExternalActions.addTask` core operation;
  the App Intent remains a thin app-target shell. Unit-test an isolated `JSONTaskStore`, device
  settings and disabled/refusing publisher, including the task's pending mark and destination.
- Extract the existing iOS `TaskifyShortcuts` provider from the iOS `@main` file into a shared
  app-target source, compile the provider and intents in both app targets, and call
  `updateAppShortcutParameters()` from each app. Do not add a Mac-only copy.
- Before calling this shipped, run the shortcut from Shortcuts with Taskify terminated in a
  signed development build. Verify that the new task appears on the requested board, remains
  pending while offline, and publishes after the app opens. Add a Mac App Group only if that
  signed test proves the system host cannot use the app's own container.
- Record ten ordinary signed launches before and after on the same machine/configuration. The
  implementation must stay within measurement noise (proposed gate: median launch-to-first-board
  regression below 5%); the compile-only prototype cannot honestly supply that runtime number.
- **Effort:** M. **Risk:** low–medium, concentrated in signing/container behavior.

##### C11-6B — Menu-bar quick add or a Mac share extension — recommend **Decline for now**

The menu item pays permanent process/startup cost without covering the closed-app case. A share
extension adds another signed target and App Group transfer queue before there is evidence that
Shortcuts plus the existing paste/drop workflow is insufficient. Revisit either only from usage
evidence after C11-6A, and keep any future surface on the same external-action operation.

### C11-7 — Closed-app DM push on Mac — recommend **Explore**

- **User:** People who expect desktop messages while Taskify is closed.
- **Question:** Is demand high enough to own another APNs topic and deployment path? The safe shape
  is a Mac-specific token/topic in the push relay, the same privacy-only preview policy, and a
  separate opt-in registration. Never reuse the iOS token contract.
- **Exploration:** document Apple provisioning and relay changes, estimate ongoing operational
  cost, and prove one development push end to end on a real Mac before proposing product UI.
- **Effort:** M to explore/verify, L to release. **Risk:** medium–high.

#### Exploration result — October 23, 2026

Apple's current registration flow requires the Push Notifications capability and the macOS
`com.apple.developer.aps-environment` entitlement from the provisioning profile. The app calls
`NSApplication.registerForRemoteNotifications()` on every launch and receives an app-and-device
specific token through `NSApplicationDelegate`; the provider sends to that token with the Mac
app's topic. See Apple's [registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[provider](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server),
[request](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
and [macOS entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.aps-environment)
documentation.

Taskify currently stops at every required boundary, intentionally rather than accidentally:

- the Mac entitlements have no APNs environment, `MacApplicationDelegate` has no token or remote
  notification callbacks, and the shared coordinator's Mac branch rejects registration;
- `DMPushRegistrationClient` sends no platform, so the server treats it as iOS;
- the relay accepts only `ios` and `watchos` APNs registrations, lowercases only those tokens and
  selects only iPhone/Watch/Snapstr topics;
- hosted and StartOS configuration have no Mac topic or migration/default; and
- there is no signed Mac development build/profile available in this review with which to prove
  Apple's delivery. An unsigned build cannot answer the provisioning question.

The incremental service cost should be low: the existing APNs token-auth connection and push
relay can send another topic, so no second provider service is implied. The ongoing cost is
operational—another App ID/profile and topic configuration, registration-contract compatibility,
self-hosted migration, and a real-device release check. This is an estimate, not a delivered-push
measurement.

##### C11-7A — Signed Mac DM-push provisioning spike — recommend **Approve**

- Add a typed registration platform to the shared Swift client (`ios` remains the explicit
  default; Mac sends `macos`) and relay contract. Cover old omitted-platform registrations plus
  iOS, Watch and Mac routing in client/server tests.
- Add an independently configured Mac topic to the relay, environment/file config and StartOS
  model/action migration. Route Mac to the existing metadata-free generic Taskify alert; do not
  create a rich-preview extension or put message metadata in APNs.
- Enable the capability only on the signed production Mac target, add AppKit registration
  callbacks, and use the existing opt-in setting. Register every launch rather than treating a
  cached token as canonical.
- Stop at a developer-only end-to-end proof: with Taskify terminated on a real Mac, one encrypted
  gift wrap produces one generic alert and opening it enters Chat. Do not expose new product UI
  or claim completion until that passes. Return its delivery/operational result before a release
  proposal.
- **Effort:** M. **Risk:** medium; blocked on Apple signing/provisioning access and a real Mac.

##### C11-7B — Ship closed-app Mac push before that proof — recommend **Decline**

Local mocks can verify the HTTP and routing contracts, but they cannot verify APNs entitlement,
topic and terminated-app delivery. Reusing the iOS topic/token shape or shipping an unproven
toggle would turn an honest unsupported state into a silent reliability bug.

### C11-8 — Do not copy phone-only parity controls — recommend **Decline**

- **Decline:** direct ports of iOS's global Completed layout toggle, fixed Startup View,
  list-index card, camera scan UI, phone widgets and the whole iOS share-extension surface.
- **Keep:** the Mac's explicit Show Completed control, per-window destination restoration,
  sidebar/table navigation, print-only scan workflow and desktop capture exploration in C11-6.
  Revisit an individual feature only with a Mac workflow and acceptance test, not to make a parity
  checklist green. Remove unused microphone/speech declarations if C11-6 does not choose voice.

### Recommended order

C11-1 (the app must build) → C11-3 stage 1 → C11-2 (must ship before December 1) → the rest of
C11-3 → C11-4 → C11-5. C11-6 and C11-7 return as concrete proposals only if the maintainer chooses
Explore. C11-8 requires no feature work.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C11-1 | Approve | 2026-10-21 | Done. The generator owns shared sources and products, has a read-only stale check, and CI runs that check, 14 presentation tests and an unsigned full app build on Xcode 27. The app build is green again. `ScaledFont` is platform-safe, the iOS-only probe stays out of Mac runtime code, and the stale call to iOS's deleted incoming-payment view is gone rather than restoring a receive path during wallet phase-out. |
| C11-2 | Approve | 2026-10-21 | Stages 1–2 implemented: recovery mode uses the shared phase-out policy, never starts the wallet service, and shows the shared storage-only recovery view; the live pre-removal wallet now consumes the same shared withdraw-only route policy as iOS and exposes no receive/incoming route. Post-date screen deletion remains scheduled with the shared iOS cleanup |
| C11-3 | Approve | 2026-10-21 | Stages 1–6 implemented. The separately identified test build uses a session-scoped temporary store/outbox and Keychain service, starts neither deferred network services nor the wallet, and shares production deep-link navigation. The package tests verify the boundary and entitlements; the app and UI runner build and sign; a live isolated launch opened the fixture task inspector. Eight CI-gated smokes now cover deep-link navigation, recovery mode, the live withdraw-only wallet, create/edit/complete/reopen, two-window stale-editor protection, two-window account-switch reset, graceful-quit persistence, and a publish-pending edit across an offline relaunch. Its injected sync engine still accepts durable local outbox work but cannot create relay transports or fresh one-shot sockets, so no Settings path can escape the isolation boundary. The app model now observes sync reports before deferred relay startup and restores the durable outbox count during load, keeping queue state truthful even while offline. This host still cannot enable local XCTest automation, so those UI assertions remain CI/local release checks |
| C11-4 | Approve | 2026-10-21 | Done. The shared Spotlight indexer now builds on macOS, updates after the same task-area saves as iOS, and gives every result the shared `taskify://task` content link. Mac opens that link through its production router, while bundle-scoped Mac domains keep the isolated host out of the production index. A ninth CI smoke covers index, open, complete and removal; `TaskifyCore` remains the single authority for which tasks are searchable. |
| C11-5 | Approve | 2026-10-21 | Done. `MacAttachmentQueue` now has one import boundary for file URLs and raw transferable image bytes. It detects the actual image type from the bytes, writes a protected temporary file with a safe generated name and real extension, and sends that file through the unchanged task/chat encryption and upload services. Both composers accept the same payload. Package regressions cover file import, invalid bytes, CoreTransferable PNG negotiation and round trips through both encryption inputs; a tenth isolated-host smoke puts PNG data with no file URL on the pasteboard and stages it in each composer. |
| C11-6 | Explore | 2026-10-21 | Complete. Compile prototypes favor shared App Intents/Shortcuts over a resident menu item. Returned C11-6A (Approve) and C11-6B (Decline) for maintainer decision. |
| C11-6A | Approve | 2026-10-23 | In progress. Stage 1 moved Add Task's complete mutation into an injected `TaskifyExternalActions.addTask` core operation. Stage 2 shares the intent/provider with the Mac `UITest` configuration and adds an isolated terminated-app `AppIntentsTesting` gate. Production configurations remain disabled until that gate passes with Apple development signing. |
| C11-6B | Decline | 2026-10-23 | Do not add a resident menu-bar process or Mac share extension without evidence that Shortcuts plus the existing paste/drop capture paths are insufficient. |
| C11-7 | Explore | 2026-10-21 | Complete as far as an unsigned review can go. Returned C11-7A (Approve a signed provisioning spike) and C11-7B (Decline release before its real-Mac proof) for maintainer decision. |
| C11-7A | Approve | 2026-10-23 | In progress. Stages 1–3 add the shared explicit Apple-platform registration contract, distinct metadata-free Mac routing, backward-compatible hosted/StartOS topic configuration, and a production-target app lifecycle plus developer-only signed proof gate. One real terminated-app development delivery and the Release provisioning check remain. |
| C11-7B | Decline | 2026-10-23 | Do not ship closed-app Mac push until a real development push reaches a terminated signed app and the release provisioning path is verified. |
| C11-8 | Decline | 2026-10-21 | No phone-only parity work will be added |

### Checkpoint — October 21, 2026 (C11-1)

Everything through C11-1 is implemented locally on `Beta`; nothing has been pushed.

- `generate-project.py --check` first failed against the hand-edited project, then passed after
  regeneration from one explicit shared-source/package-product manifest. It now retains
  `TaskifyWallet` and `WalletKeychainStores.swift` and includes the shared font and performance
  support files that arrived during the iOS work.
- The first clean app build found one more stale cross-target call:
  `ManualIncomingPaymentsView` had been deleted when iOS became withdraw-only. Mac no longer
  calls it; reintroducing receive UI for a wallet being retired would be the wrong dependency fix.
- Verification: generator check passed; Mac presentation tests passed 14/14; native
  `TaskifyCoreTests` passed 866 tests with 14 integration tests skipped; and the unsigned Mac
  `Local` app build succeeded. The app was not launched because the isolated C11-3 host does not
  exist yet.
- Next at this point was C11-3 stage 1; its implementation and verification continue in the
  checkpoint below.

### Checkpoint — October 21, 2026 (C11-3 stage 1)

Everything through the first C11-3 host stage is implemented locally on `Beta`; nothing has been
pushed.

- `UITest` is a generated Xcode configuration with bundle id `solife.me.Taskify.Mac.UITests` and
  sandbox-only app entitlements. Runtime selection is compile-time gated, so production ignores
  every UI-test launch argument. A test session receives its own temporary snapshot/outbox and
  Keychain service and starts neither relay/account services nor the wallet.
- Fixture preparation is compiled only into the test host. It creates a local-only board/task, and
  an injected `taskify://task` URL enters the same `TaskifyWidgetLink` navigation function as a
  real open-URL event. The first smoke test asserts the board, opened task inspector and completion
  action without onboarding.
- Test-first/runtime verification: the new configuration tests failed to compile before the
  boundary existed. A live launch then exposed that the destination-change observer cleared the
  cold-start deep-link selection before the inspector appeared; the new selection regression test
  failed to compile before its policy existed, then all 19 Mac package tests passed. Cold-start
  links now wait for the local snapshot to finish loading and preserve a task only when it belongs
  to the destination board. Generator `--check` failed before the
  regenerated target/configuration was committed and passed afterwards. The normal unsigned
  `Local` app build still passes.
- The clean `xcodebuild test` built and ad-hoc signed the isolated app and UI runner. XCTest then
  timed out while enabling macOS automation mode, before invoking the test method (0 passed,
  1 runner-initialization failure). This is recorded as a host-permission limitation, not a green
  UI result. CI now runs the exact smoke command on its Xcode 27 runner; developers can run it
  locally after allowing Xcode UI automation.
- A direct launch of the same isolated, ad-hoc-signed app passed the user-visible check: only the
  fixture board/task appeared, onboarding stayed closed, and the `taskify://task` link visibly
  opened `TASK DETAILS` with the Edit and Complete actions. No production account or relay was
  used.
- Next: C11-2. Add the removal-preview smoke assertion first, make production recovery mode skip
  wallet startup, then reduce the live Mac wallet to iOS's withdraw-only surface. Do not exercise
  real funds in automation.

### Checkpoint — October 21, 2026 (C11-2 stage 1)

Everything through the first C11-2 stage is implemented locally on `Beta`; nothing has been
pushed.

- `MacRuntimeConfiguration` now resolves a startup plan before executing side effects. A production
  runtime in recovery mode still starts ordinary task/sync services, but never calls
  `WalletViewModel.start()`. The package test constructs the plan and proves the wallet-start
  closure is not invoked.
- Mac recovery mode now uses the shared `WalletPhaseOut.isRecoveryMode` policy rather than a
  Mac-only preview rule. The isolated host's `--taskify-ui-test-wallet-recovery` flag is fixture
  state: it sets wallet visibility and the same hidden removal-preview key iOS uses before the
  runtime resolves recovery mode.
- The Mac wallet destination renders the existing shared `WalletRecoveryView`. That view now has
  platform-safe pasteboard and color paths: iOS keeps `TaskifyTheme` and `UIPasteboard`; macOS uses
  native secondary text, a dark background, and `NSPasteboard`. It remains storage-only and still
  loads through the shared wallet recovery file APIs.
- Test-first/verification: the new startup test failed to compile before the startup plan and
  executor existed, then all 21 Mac presentation tests passed. The shared native `TaskifyCoreTests`
  passed 866 tests with 14 environment-dependent skips. Generator `--check` failed before adding
  `WalletRecoveryView.swift` to the shared-source manifest and passed after regeneration. The
  unsigned `Local` Mac app build succeeds.
- The new isolated recovery UI smoke is present and CI runs it with the deep-link smoke. This Mac
  again timed out enabling XCTest automation before either local runner reached its test method,
  so these remain CI/local release checks rather than green local UI results.
- Next: reduce the live pre-removal Mac wallet to iOS's withdraw-only “Move funds out” surface and
  remove Receive, payment requests, new mints, mint transfers, NWC receive and the other ways to
  bring money in. Do not exercise real funds in automation.

### Checkpoint — October 21, 2026 (C11-2 stage 2)

Everything through the live pre-removal wallet reduction is implemented locally on `Beta`; nothing
has been pushed.

- `TaskifyWallet` now owns a pure `WalletMoveOutContent` policy: the introduction and balance wording,
  the route order, section titles, details, icons and availability rules. It explicitly contains
  `receive` in the route ID set so tests can prove that route is never emitted. The four move-out
  routes are pay an invoice/address, make an ecash token, move to a connected NWC wallet, and show
  the 12 words; npub.cash remains a claim-and-move-out route only when that provider is selected.
- iOS's existing `WalletMoveFundsOutSheet` now renders that shared policy instead of keeping a
  private route list. The new Mac wallet page does the same. It replaces the full wallet destination
  with withdraw-only routes, saved tokens and the 12 words; Receive, payment requests, mint
  management/transfers, P2PK management and NWC receive/NWC→ecash are no longer reachable from the
  wallet page.
- The Mac move-to-NWC sheet is move-only: it reuses `WalletViewModel.migrateToNWC()` and the existing
  sweep journal UI, but does not expose wallet switching, disconnect or receive. The recovery-words
  sheet uses the existing authenticated phrase API and macOS secure clipboard.
- Test-first/verification: the new shared policy tests first failed to compile, then passed. The
  Mac presentation suite expanded to 22 tests and passed. The shared native suite expanded to 870
  tests and passed with 14 environment-dependent skips. The iOS simulator app build and unsigned
  Mac `Local` app build succeeded. Generator `--check` failed before the new Mac source was
  regenerated and passed afterwards.
- The isolated UI-test fixture gained a separate `--taskify-ui-test-wallet-enabled` flag so the live
  wallet can be shown without entering recovery mode. CI now gates the deep-link, recovery and
  live-withdraw-only UI smokes. This host still cannot execute local XCTest automation, so the UI
  assertions remain CI/local release checks rather than green local results.
- No real funds were used. The remaining C11-2 work is the scheduled post-December-1 deletion of
  the full wallet screens and `TaskifyWallet` linkage once the shared iOS recovery cleanup happens.

### Checkpoint — October 21, 2026 (C11-3 stage 2)

Everything through the task-lifecycle isolated-host stage is implemented locally on `Beta`; nothing
has been pushed.

- The production Mac controls now expose stable accessibility identifiers for the board row, New
  Task button, task title field, Save button, task card, task title, Edit Task button and Complete
  Task button. No behavior changed; this only makes the real UI testable.
- The new isolated smoke launches the fixture board, creates a unique task, edits its title,
  completes it, preserves the temporary store, relaunches, and opens the same task through a
  `taskify://task` deep link. It asserts the edited title and completed state after relaunch.
- CI now runs four isolated UI smokes: the original deep-link smoke, wallet recovery mode, the live
  withdraw-only wallet, and create/edit/complete/reopen. The package suite remains 22 tests.
- Verification: the 22 Mac presentation tests passed, the unsigned `Local` app build succeeded,
  and `build-for-testing` compiled and ad-hoc signed both the isolated app and UI runner. The local
  host still cannot enable XCTest automation, so the new lifecycle smoke is a CI/local release
  check rather than a green local UI result.
- Next: cover the remaining C11-3 guarantees one at a time — stale editor conflict and account-switch
  reset with two windows, then quit persistence and publish-pending offline relaunch. After that,
  continue to C11-4 Spotlight and C11-5 image paste.

### Checkpoint — October 21, 2026 (C11-3 stage 3)

Everything through the two-window stale-editor regression is implemented locally on `Beta`;
nothing has been pushed.

- The existing production editor conflict remains the behavior under test: an editor retains the
  `TaskItem` revision it opened, compares that revision before uploading and again before saving,
  and leaves the sheet open with a stable error when another window or sync changed the task.
- The fifth isolated smoke opens one task editor with a stale draft, opens a real second Taskify
  window with Command-N, saves a different title there, closes that window, and proves the first
  editor cannot overwrite it. Closing the newer window before the final assertions avoids relying
  on XCTest's window z-order.
- CI and the documented local command now include the stale-editor smoke. The 22 Mac package tests,
  generator check, unsigned `Local` app build and UI `build-for-testing` all pass. A direct run again
  reached the runner but timed out while enabling automation mode before the test method began, so
  the behavior remains a CI/local release check on a Mac that grants Xcode UI automation.
- Next: prove account-switch reset across two windows, then cover quit persistence and a
  publish-pending offline relaunch before moving to C11-4 Spotlight and C11-5 image paste.

### Checkpoint — October 21, 2026 (C11-3 stage 4)

Everything through the two-window account-switch regression is implemented locally on `Beta`;
nothing has been pushed.

- The sixth isolated smoke opens unsaved task editors in two real Taskify windows, switches to a
  deterministic throwaway identity through the production Settings confirmation, and proves both
  editors and task inspectors close while both windows return to Today.
- The test surfaced an isolation bug before the account switch could be exercised safely:
  `AppModel.importIdentity` launches relay configuration plus account/contact fetches, and other
  manual Settings actions can do the same. The isolated host now injects an offline
  `TaskSyncEngine`: it still records durable outbox work but cannot create either configured relay
  transports or fresh one-shot sockets. Production behavior is unchanged, and a new core test
  locks both no-network paths while the UI test still performs the real Keychain replacement and
  local account cleanup.
- CI and the documented local command include the account-switch smoke. The generator check, 22
  Mac package tests, 871 native `TaskifyCoreTests` (14 expected opt-in skips), unsigned `Local` app
  build, and UI `build-for-testing` pass. The direct UI run again reached the runner but timed out
  enabling automation before the test method began.
- Next: prove an edit survives app termination, then prove a publish-pending edit survives an
  offline relaunch. After that, continue to C11-4 Spotlight and C11-5 image paste.

### Checkpoint — October 21, 2026 (C11-3 stage 5)

Everything through graceful-quit persistence is implemented locally on `Beta`; nothing has been
pushed.

- The seventh isolated smoke edits the fixture task and immediately sends Command-Q. This uses the
  production `NSApplicationDelegate` termination path, which waits for publication preparation and
  a direct store save before allowing the process to exit; it does not rely on the 300 ms debounced
  save winning a race with an external XCTest termination.
- The smoke relaunches the same session with its temporary store preserved, opens the fixed task
  through the production deep link, and proves the edited title and inspector survived the quit.
- CI and the documented local command include the quit-persistence smoke. No production behavior
  changed in this stage; the prior generator, package, native-core and app-build gates remain green,
  and `build-for-testing` is the relevant compile/sign gate for the new UI assertion.
- Next: prove a publish-pending edit survives an offline relaunch. After that, continue to C11-4
  Spotlight and C11-5 image paste.

### Checkpoint — October 21, 2026 (C11-3 stage 6)

Everything through offline outbox relaunch persistence is implemented locally on `Beta`; nothing
has been pushed.

- A regression smoke edits the shared fixture task while the isolated host's sync engine is
  offline, proves the board and task events appear as two queued changes, quits through Command-Q,
  then preserves the temporary store/outbox and proves both the edit and queue count survive the
  relaunch.
- The app model now installs its passive sync-report listener during load and restores the durable
  outbox count and diagnostics before the first populated frame. Socket configuration and relay
  replay remain deferred, so this does not move network work back onto startup.
- The generator check, all 22 Mac presentation tests, all 871 native core tests (14 expected
  opt-in skips), the unsigned Local app build and the isolated UI `build-for-testing` gate pass.
  The targeted UI execution was attempted before the fix, but this Mac again timed out while
  enabling XCTest automation before entering the test method.
- C11-3 is complete. Next: C11-4 Spotlight indexing and deep-link opening on macOS, then C11-5
  raw-image paste in the task editor.

### Checkpoint — October 23, 2026 (C11-4)

Everything through Mac Spotlight search is implemented locally on `Beta`; nothing has been pushed.

- The regression was written first against the isolated host. It waits for the fixed open-task
  fixture in Core Spotlight, verifies the shared `taskify://task` content link, opens that item
  into the real Mac workspace/inspector path, completes it and waits for the item to leave the
  index. It is the ninth Mac UI smoke in CI.
- The existing iOS `TaskifySpotlightIndexer` is now an explicit shared source in the generated Mac
  project. `AppModel` schedules it after task-area saves on both platforms, so the existing
  `TaskifyCore` projection still removes completed, deleted and archived-board tasks. Searchable
  items now carry `TaskifyWidgetLink.task`, and the Mac handles Spotlight activities through the
  same deep-link router used by widgets and injected links.
- iOS retains its established domain so an upgrade can remove older indexed items. Mac domains
  derive from the bundle identifier, keeping `solife.me.Taskify.Mac.UITests` isolated from the
  production Mac index.
- Verification passed: deterministic project check; 22/22 Mac package tests; 871 TaskifyCoreTests
  with 14 expected opt-in skips; unsigned Local Mac build; isolated UI `build-for-testing`; and an
  unsigned iOS Simulator app build. Targeted UI execution was attempted both before and after the
  implementation, but this Mac timed out while enabling XCTest automation before entering the
  test method.
- No new language boundary is warranted: the searchable-task projection is already shared Swift
  across iOS and macOS, and a Rust/UniFFI layer would add bridging without removing another
  implementation. Next: C11-5 raw-image paste in the task editor and chat composer.

### Checkpoint — October 23, 2026 (C11-5)

Everything through raw-image paste in both Mac attachment composers is implemented locally on
`Beta`; nothing has been pushed.

- The regression was written first and failed because the shared importer did not exist. The new
  presentation tests prove a PNG-only `NSItemProvider` selects the raw-data Transferable
  representation, byte-sniffed PNG data becomes `Pasted Image.png`, non-image bytes are rejected,
  and the staged file round-trips through both `AttachmentFileCrypto` task and chat paths. The
  original file-URL path remains covered.
- `MacAttachmentQueue` is still the single staging boundary. Both task and chat `PasteButton`s now
  accept one payload whose source is either a file URL or raw image data; drop and file-picker URLs
  enter the same importer. Raw bytes are written as owner-only temporary attachment files with a
  detected extension and MIME type, then the existing `TaskAttachmentUploadService` handles the
  encryption and upload format unchanged.
- The isolated fixture now contains a deterministic local conversation. A tenth CI smoke places
  PNG data with no file URL on `NSPasteboard`, stages it in a new task, then stages it in that chat.
  The test runner and app still have no relay or wallet startup.
- Verification passed: deterministic project check; all 26 Mac package tests; unsigned `Local`
  app build; and isolated UI `build-for-testing`. The targeted UI execution was attempted, but this
  Mac again timed out while enabling XCTest automation before entering the test method.
- No cross-client wire or behavioral contract changed, so no core JSON vector is appropriate.
  Swift's native Transferable, ImageIO and existing shared attachment crypto already cover the
  boundary; Rust/UniFFI would add a bridge to platform pasteboard APIs without removing a second
  implementation. Next: complete the recorded C11-6 and C11-7 explorations; no approved Mac
  implementation remains before the scheduled shared wallet deletion after December 1.

### Checkpoint — October 23, 2026 (C11-6/C11-7 explorations)

Everything through the approved Chunk 11 implementation and both explorations is committed or
ready to commit locally on `Beta`; nothing has been pushed. The two temporary capture prototypes
were removed and the generated project again matches its manifest.

- C11-6 measured a 40 KB Local-product delta for a same-process menu-bar field and a 192 KB delta
  for the shared iOS App Intents/Shortcuts path (6,845 bytes of extracted intent metadata), against
  the same 151,368 KB baseline. The menu item does not cover app-closed capture. The Shortcuts
  path does, but its hard-coded default store prevents a safe isolated invocation today.
- C11-6A is the concrete recommendation: first make add-task an injectable external core action,
  then share the app-target intent/provider and require a signed, terminated-app Shortcuts test
  plus a same-machine launch benchmark. C11-6B declines a resident menu item/share target until
  evidence shows Shortcuts and current paste/drop are insufficient.
- C11-7 mapped the complete Mac APNs gap: capability/profile, entitlement, AppKit callbacks,
  explicit `macos` registration platform, relay topic routing, hosted/StartOS config and a real
  terminated-app delivery. Existing APNs infrastructure keeps likely incremental service cost
  low, but signing and release-check cost remain.
- C11-7A recommends only the signed provisioning spike and generic privacy-preserving alert;
  C11-7B declines product release before one real development push succeeds.
- No runtime, wire contract or product behavior changed, so no cross-client vector or full test
  run is warranted for this documentation step. No Rust/UniFFI boundary helps either feature:
  both are Apple lifecycle/signing surfaces around existing Swift core behavior.
- Next: the maintainer decides C11-6A/C11-6B and C11-7A/C11-7B. Do not implement either approved
  candidate by inference. After those decisions (and any approved work), mark Chunk 11 done and
  review Chunk 12 with C12-n proposals before implementation.

### Checkpoint — October 23, 2026 (C11-6A stage 1)

The maintainer approved C11-6A and C11-7A and declined C11-6B and C11-7B. C11-6A stage 1 is
implemented locally on `Beta`; nothing has been pushed.

- A failing-first `TaskifyAddTaskIntentTests` pass established the missing core API. Three isolated
  regressions now cover the requested board, note, priority, device identity, task position, fixed
  clock, pending-publication durability, natural spoken-title parsing, compound-board presentation,
  failed relay publication and empty-title rejection without a write.
- `TaskifyExternalActions.addTask` now owns the entire external Add Task transaction. It accepts an
  injected `JSONTaskStore`, device settings, publisher and clock, while the iOS App Intent adapter
  supplies the production defaults. Board presentation moved beside destination resolution in
  `TaskifyCore`, so iOS and the forthcoming Mac shortcut cannot drift.
- Verification passed for the 20 focused Add Task tests, all 874 `TaskifyCoreTests` (14 environment-
  dependent skips) and an unsigned iOS-simulator app build, including App Intents metadata
  extraction.
- This is Apple external-action orchestration, not a cross-client deterministic or wire contract,
  so a shared JSON vector would give the Node clients no usable contract. Rust/UniFFI would add a
  bridge around App Intents and Swift persistence without removing another implementation.
- Next: commit stage 1; then share the App Shortcut intent/provider with the generated Mac target,
  verify extracted metadata, and attempt the required signed terminated-app invocation in an
  isolated build before enabling C11-6A.

### Checkpoint — October 23, 2026 (C11-6A stage 2 gate)

C11-6A now has the production-enable gate prepared locally on `Beta`; nothing has been pushed.

- The iOS Add Task intents and `TaskifyShortcuts` provider are explicit shared sources in the
  generated Mac project. iOS keeps them in every app build. Mac compiles and publishes them only
  for the separately identified `UITest` configuration behind `TASKIFY_MAC_SHORTCUTS`; Local,
  Debug and Release still expose no Mac shortcut surface.
- The isolated Mac external-action adapter uses the UI-test store, fixed device settings and a
  disabled publisher. Its package regression proves that the default test path is deterministic
  and cannot publish to relays.
- The existing first UI smoke still proves the injected task deep link, then terminates Taskify,
  invokes `TaskifyAddTaskIntent` through Apple's `AppIntentsTesting` process boundary, relaunches
  with the same isolated store and verifies the task. Expanding an existing CI-selected smoke
  keeps the gate active without changing the concurrently edited workflow.
- Verification passed: deterministic project generation; all 27 Mac package tests; unsigned Mac
  Local build with no relevant App Intents metadata; ad-hoc-signed Mac UITest build and UI runner
  with both Add Task intents extracted; and the iOS simulator build with the same two intents
  extracted. The targeted UI execution cannot start on this host because XCTest times out while
  enabling automation before entering the method. The host also has no valid Apple code-signing
  identity, so its “Sign to Run Locally” build cannot provide the required system registration
  proof.
- The next release-authorized step is to run the existing smoke on CI or a developer Mac with UI
  automation and Apple development signing. Only after that terminated-app invocation passes
  should `TASKIFY_MAC_SHORTCUTS` be added to Local, Debug and Release, followed by the proposed
  ten-launch median launch-to-first-board comparison with a regression budget below 5%.
- No shared JSON vector or Rust/UniFFI boundary is warranted. The durable mutation is already
  shared in Swift core; this stage is specifically Apple's signed App Intents lifecycle.
- Next: commit this safely disabled gate, then begin C11-7A with a typed `ios`/`macos` registration
  contract while keeping Mac push unavailable until a real terminated-app delivery succeeds.

### Checkpoint — October 24, 2026 (C11-7A stage 1 contract)

The cross-service Mac push contract is implemented locally on `Beta`; nothing has been pushed.

- A failing-first Swift regression established that the registration client had no typed platform
  or testable request body. `DMPushRegistrationPlatform` now emits explicit `ios` by default and
  `macos` for Mac without changing existing iOS call sites.
- `taskify-core/fixtures/dm-push-registration-vectors.json` is the shared compatibility contract.
  Both the Swift client test and Node relay test read its legacy omitted-platform, iOS, watchOS and
  macOS cases. Omitted platform still stores as iOS, preserving old clients; all Apple APNs tokens
  normalize case-insensitively.
- The relay accepts Taskify Mac registrations, routes them to an independent `macTopic`, and sends
  the existing metadata-free generic Taskify alert. Like Watch and Web, Mac receives no opaque
  preview URL or preview token; it must fetch and decrypt its inbox after opening. Snapstr remains
  limited to its iOS APNs registration.
- Verification passed: four focused Swift registration tests; all 875 `TaskifyCoreTests` with 14
  existing environment-dependent skips; all 105 push-relay tests; and all 168 Node core tests.
- This is a small cross-service wire vocabulary, so the JSON vectors are more useful than a new
  language boundary. Rust/UniFFI would not simplify APNs platform routing or Apple provisioning.
- Next: commit this contract, then add `macTopic` to environment/file/StartOS configuration with a
  backward-compatible default and migration. Production Mac capability and callbacks remain
  disabled until the independently configured topic is in place; release remains blocked on one
  real terminated-app development push.

### Checkpoint — October 24, 2026 (C11-7A stage 2 configuration)

The relay-side Mac topic is independently configurable locally on `Beta`; nothing has been pushed.

- Failing-first configuration tests now cover the hosted environment, a legacy `apns.json` with no
  Mac field, and an explicit file override. `APNS_MAC_TOPIC`/`macTopic` default to
  `solife.me.Taskify.Mac` without borrowing the iOS topic.
- The StartOS file model accepts old files through an optional field. **Configure Apple Push**
  presents an independent required Mac App Bundle ID, fills the default when an old file is read,
  and persists it on the next save. This is the configuration migration; no destructive rewrite
  is required during service startup.
- Documentation names all four independent Apple topics and makes clear that configuring the Mac
  topic does not enable Mac registration or constitute delivery proof.
- Verification passed for the four focused configuration/action tests and the TypeScript check.
  The complete relay suite is the commit gate for this step.
- This is deployment configuration around the existing Node provider. Rust/UniFFI would add no
  useful shared behavior.
- Next: commit the configuration step, then prepare the signed Mac app side—production-only APNs
  entitlement/callbacks, explicit `.macOS` registration through the existing opt-in, and a
  developer-only proof path. Keep the feature unavailable unless a valid signed profile is used,
  and do not mark C11-7A complete until one terminated-app alert opens Chat on a real Mac.

### Checkpoint — October 24, 2026 (C11-7A stage 3 signed-app gate)

The Mac app side of the signed provisioning spike is prepared locally on `Beta`; nothing has been
pushed. C11-7A and Chunk 11 are not complete because this host cannot perform the Apple-signed
delivery proof.

- The real Mac app target now owns `com.apple.developer.aps-environment`: Debug and Local expand it
  to `development`, while Release expands it to `production`. The separately identified `UITest`
  host keeps its own entitlements file with no APNs capability and its runtime never asks AppKit
  for a device token.
- `MacApplicationDelegate` forwards AppKit's token and failure callbacks to the shared coordinator.
  An already opted-in production app registers on every launch so a cached token is never treated
  as canonical. Initial opt-in and token refresh both call the shared NIP-98 client with explicit
  `.macOS`; iOS continues to send explicit `.iOS`.
- The relay's generic Mac payload already carries `taskify.type = dm-preview`. The shared
  notification delegate maps that vocabulary to `TaskNotificationNavigationRouter.chat`, which
  the Mac workspace observes, so opening an alert enters Chat without a second navigation dialect
  or message metadata in APNs.
- A `DEBUG` production-host launch can request the proof with
  `--taskify-dm-push-provisioning-spike`. It runs the existing opt-in operation with the saved (or
  default) selection, relay and server, and cannot activate in the isolated host. Release never
  consults the argument and exposes no product toggle before proof.
- Failing-first package passes established both missing boundaries: the production/test runtime
  registration split and the explicit developer proof gate. Verification then passed all 28 Mac
  package tests, deterministic project generation, unsigned Local and isolated UITest app builds,
  the unsigned generic iOS app build, and all 875 `TaskifyCoreTests` with the 14 existing
  environment-dependent skips. The targeted Mac UI smoke again stalled in Xcode before a worker
  materialized or the test method began; it was interrupted after 129 seconds, so it is not
  reported as a pass.
- `security find-identity -v -p codesigning` reports `0 valid identities found`. Therefore this
  host cannot obtain an APNs token or prove topic, environment, terminated-app delivery or alert
  navigation. Unsigned compilation deliberately does not substitute for that evidence.
- The next developer-Mac gate is: enable Push Notifications for App ID
  `solife.me.Taskify.Mac`; install an Apple development identity/profile; configure the relay's
  `macTopic` as that bundle ID with matching sandbox credentials; run a signed Debug/Local build
  with `--taskify-dm-push-provisioning-spike` and allow notifications; confirm the relay stores a
  `macos`/sandbox registration without logging the token; terminate Taskify; deliver one encrypted
  NIP-17 gift wrap; and verify one generic alert opens Chat. Then repeat the provisioning check on
  an archived Release build against production APNs before proposing product UI or release.
- This is Apple framework lifecycle and provisioning glue around the shared fixture-backed wire
  contract. Rust/UniFFI or WASM would add a bridge without making signing, AppKit callbacks or APNs
  delivery testable, so no language port is warranted.

---

## Chunk 12 — Nostr runtime and CLI

`taskify-runtime-nostr` is the shared TypeScript relay transport used by the PWA and CLI.
`taskify-cli` is the agent-facing client: its JSON and exit-code contracts matter as much as its
human output, and its mutations must keep the same task, calendar and wire semantics as the apps.

What the review found:

- **The transport has substantial behavioral coverage.** Its 17 test files exercise signatures,
  history recovery, subscription sharing and batching, NIP-42, NIP-13, per-relay pacing and the
  durable outbox. The normal suite passes 77 tests with `--test-force-exit`.
- **The forced exit still masks a real lifecycle gap.** Running the same complete suite without
  `--test-force-exit` passed all eight fake-relay NIP-42/NIP-13 cases, then stayed alive for more
  than a minute until interrupted. `RuntimeNostrSession.shutdown()` already stops subscriptions,
  publisher timers and visible relay pools, so the next step is to identify and own the remaining
  handle rather than preserve the escape hatch. Shutdown also aborts a readonly controller, which
  makes a later `init()` look supported while proof-of-work remains permanently aborted, and
  `PublishCoordinator.shutdown()` clears debounced publishes without settling their returned
  promises.
- **CLI actions often prevent their own cleanup.** There are 271 `process.exit()` calls in the
  entry point and command modules. In commands such as event CRUD and board mutations, the exit is
  inside `try` or `catch`, before `finally { await runtime.disconnect() }`; Node terminates at the
  exit call, so that cleanup is unreachable. The entry point's comment says actions have already
  shut transport down, but this is not true for those paths.
- **Most high-level CLI regression tests still inspect implementation text.** The suite passes 202
  tests, but 102 explicit test cases live in files that read `src/*.ts` and match regular
  expressions. These tests can pass when a command is unreachable, an injected value is ignored,
  cleanup is skipped, or the wrong event is published. The newer subprocess tests prove help,
  profile selection, local mutations and JSON failures, but they cannot inject a relay/runtime to
  exercise the network-backed command actions deterministically.
- **The CLI relay/domain adapter is too large to test at its seams.** `src/nostrRuntime.ts` is 1,720
  lines. It owns connection timing, task and calendar decoding, latest-event selection, cache
  merge, task/calendar/board publication and every mutation behind one closure. Much of its
  behavior is sound and already delegates normalization to `taskify-core`; the problem is the
  boundary, not a case for a ground-up rewrite.
- **One-off relay paths have drifted around the shared session.** Profile metadata, bot command
  lists, inbox-relay discovery and contact sync construct raw NDK instances. They do reuse the
  shared AUTH and proof-of-work helpers and verify received signatures, but several helpers never
  destroy their pool, while contact code owns its teardown separately. This duplicates timeout,
  verification and lifecycle policy and contributes to the CLI's dependence on hard exit.
- **The durable CLI outbox is already the right foundation.** `createCliNostrSession` supplies an
  atomic file-backed outbox to `RuntimeNostrSession`; writes are recorded before relay publication
  and replay on a later connection. The review found no reason to replace it with a new queue.
  Correct shutdown and behavioral tests should prove the existing design instead.
- **Startup is not the current problem.** The bundled entry is about 690 KB and `--help` completed
  in about 0.11 seconds on this Mac. A startup-budget project would displace correctness work
  without evidence of a user-visible bottleneck.
- **Language fit:** keep this layer in TypeScript. It directly shares `taskify-core` with the PWA,
  and NDK is the active transport on both browser and Node. The CLI already injects Node's native
  SHA-256 implementation for proof-of-work. Rust/UniFFI/WASM would add two runtime bridges without
  fixing command cleanup, relay ownership or source-text tests.

### C12-1 — One CLI exit boundary that always completes cleanup — recommend **Approve**

- **User:** CLI and agent users, especially after a failed or queued network write.
- **Problem:** `process.exit()` inside command actions bypasses `finally`, so runtime disconnect,
  pending output and other cleanup are not reliable. This is a behavior bug, not only style debt.
- **Proposal:** make actions return normally after setting a typed result/`process.exitCode`; only
  the outer executable boundary may choose the final process status, after `parseAsync` and all
  action cleanup finish. Convert network-backed commands first, then local commands. Keep the
  current exit codes and JSON/human output byte-for-byte unless a failing behavior test proves a
  bug. Add a lint/test guard that command modules do not call `process.exit`.
- **Test first:** inject a runtime whose `disconnect` records completion. Prove success, validation
  failure, relay failure and queued-write paths all disconnect before the command resolves, retain
  their existing status, and emit exactly one JSON envelope in agent mode.
- **Effort:** M because the calls are numerous but mechanical. **Risk:** medium; stage it by command
  group with a green bundled-CLI test after each commit.

### C12-2 — A behavioral command harness, then retire source-regex tests — recommend **Approve**

- **User:** Maintainers and agent users who depend on stable machine-readable behavior.
- **Proposal:** separate `buildProgram(dependencies)` and `runCli(argv, dependencies)` from the
  executable side effect. Inject config persistence, `NostrRuntime`, attachment/share transports,
  clock/UUID and stdout/stderr; use in-memory fakes in tests. Keep a small subprocess layer for the
  actual bundle, argument parsing and OS exit code. Replace source-text tests in risk order:
  event/task mutations and recurring completion, boards/lists, contacts/sharing, then registration
  and presentation. Delete each regex assertion when its real behavior test lands.
- **Test shape:** call the real Commander action with a recording fake runtime and assert calls,
  returned status, output and cleanup. The fake is not a second implementation of Nostr; lower
  runtime tests remain responsible for signed event transport.
- **Effort:** M–L, naturally incremental. **Risk:** low after C12-1 supplies one lifecycle model.

### C12-3 — An explicit, terminal runtime shutdown contract — recommend **Approve**

- **User:** PWA and CLI users; both consume this package.
- **Proposal:** find the open handle exposed by removing `--test-force-exit`, then make every owned
  timer, subscription, relay callback and pool close through one idempotent `shutdown()`. Pending
  debounced publish promises must either finish or reject with a named shutdown error; they must
  never be silently abandoned. Make shutdown explicitly terminal (a later operation fails fast),
  or rebuild all abort-owned components on restart—do not advertise the current half-restart.
  Add a small owned standalone-session API for profile/contact/bot reads and writes so raw NDK
  helpers share signature verification, AUTH/PoW, timeouts and close semantics.
- **Test first:** the complete runtime suite must finish naturally without `--test-force-exit`;
  focused tests cover double shutdown, operation after shutdown, a debounced publish during
  shutdown, and each standalone helper closing on success, timeout and error.
- **Effort:** M. **Risk:** medium because relay teardown races are timing-sensitive; use the local
  fake relay, not public infrastructure.

### C12-4 — Split the CLI Nostr adapter by domain behind the same interface — recommend **Approve**

- **User:** Indirectly all CLI users; this reduces drift without changing commands.
- **Proposal:** after the harness exists, extract task codec/repository, calendar codec/repository,
  board repository and cache merge from `nostrRuntime.ts`. Keep `NostrRuntime` as the facade the
  commands consume and inject one session/clock/config store. Move deterministic behavior to
  `taskify-core` when another client also owns it; keep Node persistence and relay orchestration in
  the CLI/runtime. Port line by line and preserve event tags, timestamps, encryption, errors and
  cache keys.
- **Test first:** characterize each current facade method through the fake session before moving
  it. A refactor commit must not change the signed event templates or public return records.
- **Effort:** L in small commits. **Risk:** medium if attempted as one rewrite, low when split one
  domain at a time.

### C12-5 — Make the CLI consume the existing cross-client wire vectors — recommend **Approve**

- **User:** Anyone editing a task or calendar event from more than one client.
- **Proposal:** run the CLI task/calendar decoders and encoders against the existing
  `task-event-vectors-*.json`, `calendar-event-vectors-*.json` and event-version vectors. The PWA
  and Swift remain the vector producers; the CLI becomes a third consumer. Export only the pure
  codec seams needed by the test. If a vector exposes a difference, first decide the shared
  behavior in `taskify-core`, then add/fix the vector and its Swift coverage before changing a
  client.
- **Test first:** the current fixtures are the tests. Do not replace them with CLI-only snapshots.
- **Effort:** S–M after C12-4 exposes codecs. **Risk:** low; it may reveal intentional CLI omissions
  that should be documented rather than copied.

### C12-6 — Port the runtime or CLI to Rust/UniFFI/WASM — recommend **Decline**

The expensive and failure-prone work here is relay lifecycle and command orchestration, not a CPU
kernel. A Rust port would lose the direct browser/Node NDK sharing, require JavaScript and Swift
bridges, and still need platform-specific WebSocket, persistence and process-lifecycle code. Keep
native hashing injected for proof-of-work. Revisit only if measurements later show mining dominates
real commands and a small isolated WASM hashing worker beats the existing Node/browser workers; do
not port the session or domain facade for that hypothetical gain.

### C12-7 — Event RSVPs in the CLI the way the PWA and iOS do them — **Approved**

Found during C12-4 step 3 (October 25). The CLI and the other clients use different RSVP channels,
so a response never crosses between them in either direction.

- **PWA and iOS (they match).** An attendee publishes their own kind 30312 event:
  - signed with their own key;
  - `d` = `<eventId>:<attendeePubkey>` and `a` = the event's canonical 30310 address;
  - NIP-44 between the attendee and the board's key: `{v: 1, eventId, status, inviteToken, fb?,
    note?}`.

  The organizer stores nothing. It reads the responses on the board's relays and keeps one only
  if it names this event and carries one of the event's invite tokens (or the token derived for
  that attendee from the board). It shows the newest per attendee.
- **The CLI.**
  - As attendee, `event rsvp --to <npub>` sends an `event-rsvp-response` DM that neither the PWA
    nor iOS sends or reads.
  - As organizer, `share inbox --apply` writes one `rsvpStatus` onto the board's copy, re-signed
    with the board key, with `lastEditedBy` set to the attendee.
  - It never reads kind 30312.
- **Decision.**
  - The rule goes into `taskify-core`, with shared vectors for Node and Swift: building an RSVP,
    the organizer's acceptance check, the board-derived token, and the newest per attendee. The
    PWA uses it.
  - The CLI publishes kind 30312 from the invite in its share inbox.
  - As organizer, the CLI reads responses live and stops rewriting the board's copy.
  - The DM envelope is no longer sent. One from an older CLI is still listed, but not applied.
  - No migration: other clients ignore a stray `rsvpStatus`, and the CLI stops reading it.

### Decisions

| ID | Decision | Date | Outcome |
| --- | --- | --- | --- |
| C12-1 | Approve | 2026-10-25 | Done in seven staged commits; only `src/index.ts` may hard-exit |
| C12-2 | Approve | 2026-10-25 | Done in seven stages. Every CLI command group runs through `buildProgram`/`runCli` with injected config (load and save), runtime, clock, UUIDs, prompt, share transport and output; every source-regex test of command code is replaced by behavior, and the remaining source assertions target the runtime for C12-4 (and raw NDK contact reads for C12-3). Found and fixed on the way: `upcoming` dates, `board create` in scripts, `boards`/`board list` drift, `share inbox --apply` progress, and `event invite`/`share event` (shared invitation rule in core) |
| C12-3 | Approve | 2026-10-25 | Done in three stages. Shutdown is terminal and idempotent and finishes debounced publishes; NDK's unstoppable relay timer is shimmed and its multi-relay reconnect avoided, so processes exit by themselves and the runtime suite runs without `--test-force-exit`; `StandaloneNostrSession` is the owned path for one-off reads and writes, and the CLI uses it for profiles, contacts and bot lists |
| C12-4 | Approve | 2026-10-25 | Done in four steps. `nostrRuntime.ts` (about 1,780 lines) is now a 176-line facade over the task, calendar and board repositories in `src/runtime/`. Each domain is pinned by behaviour on a loopback relay (`runtime-tasks`, `runtime-calendar`, `runtime-boards`), and no test reads runtime source any more. Found on the way: `createEvent` board names, RSVPs across clients (C12-7), the board-definition leak, and the two sync fixes below |
| C12-5 | Approve | 2026-10-26 | Done. The CLI reads and edits the PWA's and iOS's task and calendar vectors through its runtime, and orders versions by the shared vectors. Two CLI differences found and fixed: case-sensitive version ids, and CLI edits dropping synced reminders |
| C12-6 | Decline | 2026-10-25 | Keep TypeScript/NDK; reconsider only from measured hashing cost |
| C12-7 | Approve | 2026-10-25 | Done in four commits. The RSVP rule (build, organizer check, board-derived token, newest per attendee) is in `taskify-core` with vectors iOS checks. The PWA calls it. The CLI publishes kind 30312 answers and reads them live; it no longer sends the RSVP DM or rewrites the board's copy |

### Checkpoint — October 24, 2026 (Chunk 12 review)

The Chunk 12 review is complete; no implementation has started and nothing has been pushed.

- Baselines remain green at the reviewed head: CLI 202/202 and runtime 77/77 with its current
  forced-exit script. The no-force runtime experiment passed the fake-relay cases but did not
  terminate and was interrupted after more than a minute; it is evidence for C12-3, not a passing
  gate.
- C12-1 through C12-5 are recommended for approval in that order. C12-6 is recommended for
  decline. C12-4 and C12-5 should wait until the command harness and lifecycle work make behavior
  observable without source inspection.
- The next step is the maintainer's decisions. Do not infer approval or begin implementation from
  this review. If approved, start C12-1 with a failing cleanup test and one command group; preserve
  the unrelated runtime-security manifest/workflow changes already present in the worktree.

### Checkpoint — October 25, 2026 (C12-1 stage 1)

The maintainer approved C12-1 through C12-5 and declined C12-6. The first C12-1 command group is
implemented locally on `Beta`; nothing has been pushed.

- A bundled-process regression was written first. It intercepts the executable's hard-exit call
  in an isolated home and proved that `event list` called `process.exit` once inside the action and
  once at the executable boundary. That action-level exit prevented its `finally` cleanup in a
  real process.
- All event commands now return normally. Early validation/not-found paths set the intended exit
  code and return; caught failures set it; success leaves zero unchanged. Their existing
  `finally { await runtime.disconnect() }` blocks therefore finish before the sole hard exit in
  `index.ts`. JSON and human output are unchanged.
- The full CLI suite passes 203/203 after rebuilding the bundle. This stage changes process
  lifecycle only; it does not change a cross-client behavior or wire contract, so no shared JSON
  vector or Swift run is appropriate.
- Next: continue C12-1 through the remaining network-backed command groups, with a lifecycle
  regression/guard for each stage, then remove action-level exits from the local-only groups.

### Checkpoint — October 25, 2026 (C12-1 stage 2)

Task query and mutation actions now follow the event-command lifecycle; nothing has been pushed.

- `list`, `upcoming`, `show`, `search`, `reorder`, `remind`, `add`, `done`, `reopen`, `delete`,
  `subtask` and `update` no longer hard-exit. Their `finally` blocks own the one runtime disconnect,
  including the interactive delete-abort path, which previously disconnected and exited inside the
  `try` before reaching the same cleanup again.
- Early validation and interactive-selection failures now set status and return from the action;
  success/failure status computed in each command is handed back through `process.exitCode` after
  disconnect. Agent JSON and human rendering are unchanged.
- The bundled lifecycle regression covers the task failure path as well as event success. The full
  CLI suite passes 204/204 after rebuilding.
- Next: board and board/list mutation actions, which contain the largest remaining cluster of hard
  exits, then the sharing/attachment/transfer groups.

### Checkpoint — October 25, 2026 (C12-1 stage 3)

Board actions now follow the same single-exit lifecycle; nothing has been pushed.

- Board/default/list/admin and compound-board actions no longer hard-exit. Validation failures set
  the existing status and return, while success returns normally to the executable boundary.
- Every runtime created by the board commands now disconnects through `finally`, including the
  best-effort display-name refresh after `board list`, join metadata refresh, `columns` and
  `overview`. The optional single-board sync lookup is action-scoped rather than hidden inside an
  IIFE, so a missing board returns from the command instead of only from a nested function.
- The bundled lifecycle regression now covers `board list`. The production bundle builds and the
  full CLI suite passes 205/205.
- Next: remove action-level exits from sharing, attachment, assignment, inbox and transfer
  commands, preserving their output and exit statuses while making their cleanup reachable.

### Checkpoint — October 25, 2026 (C12-1 stage 4)

The sharing, attachment, assignment, inbox and transfer command groups now return to the
executable boundary; nothing has been pushed.

- A failing bundled-process regression first showed that a missing-board `share board` validation
  path could invoke `process.exit(1)` three times: the action continued after its first intercepted
  exit, then the executable handled both the resulting exception and its final status. The command
  now sets the status and returns immediately, producing one hard exit.
- All runtime-backed actions in these groups preserve their existing result code through
  `process.exitCode` only after `await runtime.disconnect()` completes. Attachment success and
  failure paths now reach their existing `finally`; import validation, empty input, dry-run and
  interactive abort return before a runtime is created.
- The production bundle builds and the full CLI suite passes 206/206. No cross-client behavior or
  wire format changed, so no shared fixture or Swift run is appropriate.
- Next: convert profile, contact, bot and relay commands, including their standalone NDK helpers;
  C12-3 will subsequently consolidate those helpers behind the shared terminal session contract.

### Checkpoint — October 25, 2026 (C12-1 stage 5)

Profile, contact, bot and relay actions now return to the executable boundary; nothing has been
pushed.

- A failing bundled-process regression first proved that even local `profile list` performed an
  action-level hard exit before the executable issued its final exit. Identity success,
  validation, not-found, interactive-abort and relay-status paths now return with the same output
  and status.
- Runtime-backed relay status and contact fetch still complete their existing disconnect blocks.
  Raw NDK profile/contact/bot helpers retain their current transport behavior in this lifecycle-only
  step; C12-3 owns putting them behind one teardown-capable standalone-session API.
- Profile-media upload failure now records its status and stops the action before trying another
  upload or publishing partial metadata, matching the immediate-stop behavior previously supplied
  by `process.exit` without terminating inside the helper.
- The bundle builds, `npx tsc --noEmit` passes and the full CLI suite passes 207/207. No shared
  client behavior or wire contract changed.
- Next: convert the remaining local/admin command groups and command-context/onboarding helpers,
  then add the architectural guard that only `src/index.ts` may call `process.exit`.

### Checkpoint — October 25, 2026 (C12-1 stage 6)

The remaining local and administrative command actions now return normally; nothing has been
pushed.

- A failing bundled-process regression showed that an empty `cache status` continued through two
  action-level exits before reaching the executable, producing three hard-exit calls in total when
  exits were intercepted. Cache, backup, config, completion, setup, trust, agent and board-creation
  paths now preserve their output/status and return.
- `config set default-list` owns its runtime in one `finally`, including missing-list and missing-
  profile failures. The legacy `boards` alias also disconnects its best-effort display-name refresh
  runtime on failure as well as success. Nested AI-triage failure records its local result before
  the outer cleanup publishes that status.
- The production bundle builds, `npx tsc --noEmit` passes and the full CLI suite passes 208/208.
  This is process lifecycle only; shared behavior and wire formats are unchanged.
- Next: replace hard exits in command-context and onboarding helpers with typed returns/errors,
  then enforce the outer-boundary rule with a source architecture guard and finish C12-1.

### Checkpoint — October 25, 2026 (C12-1 stage 7 — complete)

C12-1 is complete locally on `Beta`; nothing has been pushed.

- Command-context validation, board/column resolution and runtime construction now throw a typed
  `CliReportedError` after rendering their existing human error. That error unwinds through any
  action cleanup and tells the executable only the final status; it cannot produce a duplicate
  human message or agent JSON failure envelope. Onboarding cancellation returns normally.
- Best-effort metadata/title catches rethrow this typed failure rather than accidentally treating
  failure to construct a runtime or resolve an explicitly requested board as optional. Runtime
  `finally` blocks still run while the reported failure reaches the executable boundary.
- A source architecture guard now scans all CLI TypeScript below `src/` and fails if any file
  except `src/index.ts` calls `process.exit`. A bundled regression also proves a reported helper
  failure emits its original error once and reaches exactly one executable hard exit.
- The production bundle builds, `npx tsc --noEmit` passes and the complete CLI suite passes
  210/210. C12-1 changes process lifecycle only; no cross-client vector or Swift run is needed.
- Next: C12-2, beginning with a `buildProgram(dependencies)`/`runCli(argv, dependencies)` seam and
  a recording fake runtime, then replacing the highest-risk source-regex assertions with behavior
  tests one command family at a time.

### Checkpoint — October 25, 2026 (C12-2 stage 1)

The first behavioral command-harness stage is complete locally on `Beta`; nothing has been pushed.

- `src/cli.ts` now owns importable `buildProgram(dependencies)` and
  `runCli(argv, dependencies)`. The executable composes relay settings, awaits `runCli`, and owns
  the only hard exit. The build emits a separate non-executing `dist/cli.js` bundle for tests as
  well as the normal shebang-bearing `dist/index.js`.
- Commander runs with `exitOverride()`. A failing bundled regression first showed that intercepted
  `--help` attempted four exits (help, then three error exits as execution continued); it now
  prints the same help and returns status zero to the executable boundary exactly once. Commander
  parse failures likewise return their own status without a duplicate Taskify error envelope.
- Dependencies can now supply runtime construction, config reads, relay checks, onboarding and a
  version. Event commands consume the injected config seam. The first in-process behavior tests
  drive the real `event list --json` action with a recording fake runtime and prove arguments,
  output, success/failure status and awaited disconnect without relay traffic or a child process.
- `AGENT.md` lists the new harness test. The bundle builds, `npx tsc --noEmit` passes and the full
  CLI suite passes 214/214.
- Next: characterize event/task mutations and recurring completion through injected runtime,
  clock/UUID/output seams, then delete the matching source-regex assertions as each behavioral
  replacement lands.

### Checkpoint — October 25, 2026 (C12-2 stage 2)

The event-command source-surface tests have been replaced with behavior tests; nothing has been
pushed.

- The deleted `event-cli-surface.test.ts` contained six regex assertions over command source. The
  harness now asks the real Commander tree for CRUD/JSON registration and executes list, show,
  update and delete against a recording runtime.
- The behavior tests prove optional board resolution, the exact update patch passed to the runtime,
  JSON mutation output, cross-board list labels, show-board metadata, status and disconnect order.
  They therefore fail when the command is unreachable, ignores an option or calls the wrong
  runtime method—cases the source assertions could not distinguish.
- The bundle builds, `npx tsc --noEmit` passes and the full suite passes 211/211 after removing the
  six regex cases and adding three broader behavioral cases.
- Next: inject task-command config plus clock/UUID/idempotency dependencies and characterize task
  creation, status mutations and recurring completion before retiring their corresponding source
  assertions.

### Checkpoint — October 25, 2026 (C12-2 stage 3)

Task mutation commands now run through the behavioral harness; nothing has been pushed.

- The command dependency seam now supplies UUID generation, the idempotency store and agent JSON
  writer as well as config/runtime. `taskMutations.ts` no longer reaches the filesystem-backed
  idempotency store, global UUID source or stdout writer directly; production defaults are the same.
- A real `add` action proves location resolution, stable idempotency-key namespacing, reserved task
  ID, exact `createTaskFull` input, agent response and disconnect order. A real `done` action proves
  status arguments and that the runtime's recurring `nextOccurrence` reaches the agent response
  before cleanup.
- The runtime-level regex in `recurring-completion.test.ts` remains intentionally: the command fake
  cannot prove that the current monolithic runtime actually publishes the next occurrence. C12-4
  must replace that assertion with a repository/session behavior test before deleting it.
- The build, `npx tsc --noEmit` and the full CLI suite pass at 213/213.
- Next: inject task-query config/output, replace list/upcoming command source assertions with
  runtime-call/output behavior, then continue through board and sharing command groups.

### Checkpoint — October 25, 2026 (handoff after C12-2 stage 3)

Work is stopped at a clean implementation boundary. All Taskify improvement-review work described
below is committed locally on `Beta`; nothing has been pushed.

- **Completed:** C12-1 in seven staged commits. All CLI command code returns through cleanup;
  `src/index.ts` owns the only hard exit, reported helper errors unwind without duplicate output,
  and the architecture guard enforces that boundary.
- **C12-2 completed so far:** stage 1 added importable `buildProgram`/`runCli` plus injected config,
  runtime, relay-check and output dependencies; stage 2 replaced the event command source-surface
  regex tests with behavior; stage 3 added deterministic UUID/idempotency/output seams and real
  task-create/task-done behavior tests. C12-2 is not complete.
- **Current verification:** `npm run build`, `npx tsc --noEmit` and all CLI tests pass, 213/213.
  No shared core or Swift source changed in these stages, so no core/Swift run was required.
- **Next, in order:** (1) inject `loadConfig` and agent output into `taskQueries.ts`; add recording-
  runtime behavior for `list`, `upcoming`, `show` and `search`, preserving agent envelopes and
  cleanup; retire only the matching source-regex assertions whose behavior is now proved;
  (2) migrate board/list command behavior and remove its replaced source tests; (3) migrate
  contact/sharing behavior and registration/presentation checks; (4) finish C12-2 only when each
  remaining source assertion is either replaced by behavior or explicitly retained for C12-4's
  runtime-repository characterization.
- **Do not delete yet:** the runtime assertion in `recurring-completion.test.ts` that checks
  `setTaskStatus` calls the recurrence builder and duplicate lookup. The current command fake proves
  forwarding/output, not the monolithic runtime's publication; replace that assertion during C12-4
  with a fake-session repository behavior test.
- **Preserve unrelated worktree changes:** `.github/workflows/ci.yml`; package manifests/locks in
  CLI, core, PWA, runtime, worker and push relay; `taskify-push-relay/Dockerfile`;
  `taskify-push-relay/startos/actions/configureWebPush.ts`;
  `taskify-push-relay/startos/versions/current.ts`; and untracked
  `docs/audits/runtime-security-2026-10-22.md`. They belong to a separate runtime-security pass and
  must not be staged with improvement-review commits.
- Continue the one-step/one-commit rule with the required Claude co-author trailer. Never push;
  the maintainer owns pushing.


### Checkpoint — October 25, 2026 (C12-2 stage 4)

Task queries now run through the behavioral harness; nothing has been pushed.

- `taskQueries.ts` takes config, agent output and a clock from the command context instead of
  importing `loadConfig`, the stdout writer and `new Date()`/`Date.now()`. `CliDependencies.now`
  injects the clock; production defaults are unchanged.
- `task-query-commands.test.ts` (15 cases, fixtures in `tests/helpers/cliHarness.ts`) drives the
  real `list`, `upcoming`, `show` and `search` actions against a recording runtime. It proves the
  arguments each passes to the runtime (`--in`, `--board`/`--column`, `--status`, `--all`,
  `--refresh`, `--no-cache`, `--days`), `--mine` assignee filtering, the `task.list`, `task.get`
  and `task.search` envelopes, validation and NOT_FOUND failures, human output, and that disconnect
  is always last. Three deliberate source mutations (upcoming priority sort, `--no-cache`
  forwarding, note search) each turned exactly one case red.
- Retired: `upcoming-filter.test.ts` (11 regex cases) and the "list semantics" regex case in
  `parity-phase3b-cli-surface.test.ts`. Its `resolveColumnOrExit` pattern for task add/update is
  still asserted in `list-targeting-cli.test.ts` and moves with the board/list stage.
- **Found:** `upcoming` takes "today" and its cutoff from the UTC date
  (`toISOString().slice(0, 10)`), so west of UTC in the evening a task due today drops out, and a
  timed task due on the cutoff day is excluded because a full ISO string sorts after the bare
  date. The stage 4 tests use a time when UTC and local dates agree; the fix follows below.
- The build, `npx tsc --noEmit` and the full CLI suite pass at 216/216.

### Checkpoint — October 25, 2026 (CLI `upcoming` dates)

- Two failing tests came first, in `task-query-commands.test.ts`:
  - At 9 pm in Chicago (already the next day in UTC), today's tasks were missing from `upcoming`.
  - A timed task on the last day of the window was excluded.
- `upcoming` now uses `taskify-core`'s date keys, as the apps do:
  - "today" is `todayDateKey(now)`;
  - the window ends at `addDaysToDateKey(today, days)`;
  - a task's day is `isoDatePart(dueISO, dueTimeZone)`, so a date-only task saved as local
    midnight keeps its day.
  - Order is day, then priority, then time.
- The OpenClaw command reference said the default window was 7 days; it is 14, and now says so.
- The CLI suite passes at 218/218 and `npx tsc --noEmit` is clean.
- Next: board/list behavior, then contact/sharing and registration/presentation checks.

### Checkpoint — October 25, 2026 (C12-2 stage 5)

Board and list commands now run through the behavioral harness; nothing has been pushed.

- `boards.ts`, `boardCreation.ts` and `boardListAlias.ts` take config loading and saving, the clock
  and UUIDs from the command context. `CliDependencies.saveConfig` is new; the harness records
  saves. Each harness load now returns a fresh copy of the config, since commands mutate it.
- `board-commands.test.ts` (13 cases) covers:
  - every board settings command (`rename`, `archive`/`unarchive`, `hide`/`unhide`, `index-card`,
    `share-settings`, `sort`), with the exact `updateBoard` patch, boards named by id or by
    case-insensitive name, and bad input rejected before any update;
  - `clear-completed`;
  - list column add, rename, delete and reorder;
  - compound child add, remove and reorder;
  - `board columns`, with an offline fallback to the saved columns;
  - `default`, `column-default` and `--clear`, through the saved config;
  - `join` (with the command clock) and `leave`;
  - compound `create`;
  - the column guards for list-less boards and ambiguous names;
  - the `[col: …]` confirmation from `add --human`.
- Mutation check: flipping archive's flag and dropping child-add's duplicate guard each failed a
  case. Removing the column-reorder clamp changed nothing, because `splice` already clamps.
- Retired (12 regex cases):
  - three command-registration cases in `board-phase1-cli-surface.test.ts`;
  - five CLI sort cases in `board-sort.test.ts`;
  - three CLI cases in `list-targeting-cli.test.ts`;
  - the CLI board-resolution case in `board-core-integration.test.ts`.

  Their runtime and config-type regexes remain for C12-4.
- Found, to fix next, each with a failing test first:
  - `board create --kind lists` always prompts on stdin for column names, so a script or agent
    never gets the board created;
  - the `boards` alias duplicates `board list` but without its 24-hour refresh or relay display.
- The build, `npx tsc --noEmit` and the CLI suite pass at 219/219.
- Next: those two fixes, then contact/sharing and registration/presentation checks.

### Checkpoint — October 25, 2026 (CLI `board create` in scripts)

- Failing tests came first. In a script, `board create <name>` (a lists board by default) waited
  on stdin for column names. The test run hung past its own time limit, because the open readline
  kept the process alive. `--columns` did not exist.
- The command context has a `prompt` seam (`src/shared/prompt.ts`). It asks only when stdin is a
  terminal and returns null when nobody can answer, including when input ends.
- `board create` takes list names from `--columns`, asks in a terminal, and otherwise creates the
  board without lists.
- The confirmation prompts in `agent` and `transfer`, and inbox triage, still open their own
  readline. They have `--yes` for scripts, and move to the seam when their commands are
  characterized.
- Also found, for the `boards` step: the command reference shows `taskify boards --json`, but
  neither `boards` nor `board list` has a `--json` option.

### Checkpoint — October 25, 2026 (CLI `boards` is `board list`)

- Failing tests came first:
  - `boards` refreshed only boards still named by id, while `board list` also refreshes boards
    last synced over a day ago;
  - `boards` left out the board's relays;
  - `--json` was missing from both commands, though the command reference shows it.
- `board list` and `boards` are now one action in `boards.ts`, and `boardListAlias.ts` is gone.
  `--json` lists each board's id, name, kind, relays and lists.
- The CLI suite passes at 223/223 and `npx tsc --noEmit` is clean.
- Next: contact/sharing behavior (C12-2 stage 6), then registration/presentation (stage 7).

### Checkpoint — October 25, 2026 (C12-2 stage 6)

Sharing, assignment and backup relay merges now run through the behavioral harness; nothing has
been pushed.

- The command context has a share-transport seam (`CliDependencies.shareTransport`: NIP-17 send
  and inbox read). Sharing, assignments, event invite/RSVP and discovery use it. Backup commands
  now receive the context, and response timestamps use the command clock.
- `share-commands.test.ts` (7 cases) covers:
  - board and task shares, with the exact envelope, sender key, recipient and relays;
  - assignment and RSVP responses, carrying the command's time;
  - delivery failure, which returns status 1 and still disconnects;
  - share inbox listing;
  - `--apply`: a new board is joined and an existing one isn't duplicated, a task is created on
    the default board, assignment and RSVP responses are applied, and processed message ids are
    saved;
  - assign (no duplicate assignee, `--notify` sends an assignment request) and unassign;
  - `backup merge-relays`, including `--dry-run`, a backup with no relays, and an unreadable file.
- Retired 20 regex cases:
  - 14 in `contacts.test.ts`. The subprocess contact test in `command-registration.test.ts`
    already proves registration, profile-scoped persistence, lookup by name or pubkey prefix, and
    npub validation. The `contact fetch` and `contact sync` cases stay until C12-3 gives the raw
    NDK reads a seam.
  - Two each in `share-phase2-cli-surface.test.ts` and `share-phase3-cli-surface.test.ts`.
  - `backup-cli-surface.test.ts`.
- **Found: `event invite` and `share event` never succeed.**
  - The CLI builds calendar addresses with NIP-52 kinds 31923/31924. Taskify uses 30310/30311,
    so `buildCalendarEventInviteEnvelope` rejects every invite ("Invalid calendar event
    address").
  - It also invents the event key and a per-recipient token. The PWA uses the event's real
    `eventKey`, and saves per-recipient invite tokens into the event, republishing it, under
    board-key addresses.
  - Token merging exists only in the PWA. The fix moves it to `taskify-core` with shared vectors
    and adds a runtime invite operation, with a failing test first. The two regex cases about
    `share event` and `event invite` registration stay until then.
- **Found: `share inbox --apply` saved processed ids only after the whole batch.** If the runtime
  failed partway, tasks already created were not recorded, and the next apply created them again.
  Fixed: a failing test first, then the config is saved after each applied message (CLI suite
  211/211).

### Checkpoint — October 25, 2026 (shared calendar invitation rule)

The first half of the `event invite` fix: one rule for invitation secrets, in `taskify-core`.

- `planEventInvitations` gives each invitee their own token, keeping existing ones and dropping
  removed invitees. The sender never gets a token. The event key is kept unless it is missing or
  isn't 32 bytes of base64.
- Between two spellings of one key, the token under the lowercase-hex spelling wins, then the
  smallest token. The old "first wins" depended on object order, which isn't portable; Swift's
  dictionary order made it random.
- `fixtures/event-invitation-vectors.json` (8 cases) is written from the TS planner and checked by
  `event-invitation-vectors.test.ts` and Swift `EventInvitationVectorTests`.
- iOS's `TaskifyEventInvitationPlanner` already followed this rule, except for duplicate
  spellings, which now use the portable tie rule.
- The PWA's `mergeInviteTokens` now calls the core planner and passes the sender. Previously it
  wrote a token for the sender, and kept a malformed event key that its own encryption then
  refused. All three clients generate 32-byte base64 keys, so real events keep theirs. The
  publisher test's placeholder key `"k1"` became a real-format key.
- Verification:
  - core 170/170;
  - Swift 876 (14 skipped);
  - PWA `tsc` clean;
  - the PWA calendar publisher tests pass. The one remaining PWA failure, in
    `taskCommands.test.ts`, was already failing; the next fix covers it.

### Checkpoint — October 25, 2026 (PWA board visibility used the real clock)

- `taskCommands.test.ts` ("moves the due date a week later and hides the task until then") began
  failing once the real date passed October 22. The postpone planner is given a clock, but
  `hiddenUntilForBoard` read `new Date()`, so whether a postponed task was hidden depended on when
  the plan ran, not on the plan's own time.
- `hiddenUntilForBoard` and `applyHiddenForFuture` now take `now`. The postpone and
  generated-task planners pass theirs; UI callers keep the current time.
- The PWA suite passes (746, 14 skipped) and `tsc` is clean.

### Checkpoint — October 25, 2026 (CLI event invitations work)

The second half of the `event invite` fix. Failing test first: the command test expected a valid
invite envelope.

- **Runtime.** It applies the shared rule (`src/shared/eventInvite.ts`, which calls
  `planEventInvitations` with an npub-aware key normalizer):
  - `createEvent` gives each invitee a token;
  - `updateEvent` keeps tokens in step with participants: new invitees get one, removed ones lose
    theirs. Before, events made or edited in the CLI had invitees with no token, so they couldn't
    open the event even if invited elsewhere.
  - New `inviteToEvent` adds the recipient, republishes, and returns Taskify's calendar addresses
    (30310/30311 under the board's key), the recipient's token and the board's relays.
- **Command.**
  - `event invite` sends that result. The envelope carries the board's relays; it is sent over
    the board's relays plus the profile's, as the PWA sends.
  - `share event` re-parsed the whole command line with a malformed argv, so it never reached the
    invite; it now uses the same action.
- **Tests.**
  - `event-invite.test.ts` covers the helper.
  - `share-commands.test.ts` covers both commands and the not-found case.
  - The last two regex cases in `share-phase2-cli-surface.test.ts` are replaced and the file is
    removed.
- The runtime wiring is checked by the compiler, not by a test: the runtime has no test seam
  until C12-4. Not tried against a real relay or a second client yet.
- The CLI suite passes at 216/216 and `npx tsc --noEmit` is clean.

### Checkpoint — October 25, 2026 (C12-2 stage 7 — complete)

C12-2 is complete. Nothing has been pushed.

- `presentation-commands.test.ts` (4 cases) covers:
  - the rich task flags (`--recurrence-json`, `--documents-json`, `--assignee`) and event flags
    (`--column`, `--recurrence-json`, `--reminders`, `--invitee`) reaching the runtime parsed;
  - malformed JSON stopping before any write;
  - `show --human` listing documents and each assignee's state;
  - `event show` listing invitees with roles and the RSVP state.
- Retired:
  - three cases in `parity-phase3b-cli-surface.test.ts`;
  - `share-phase3-cli-surface.test.ts`;
  - the `commandSource` helper, which no test reads any more.
- **What source assertions remain, and why:**
  - Runtime regexes in `board-core-integration`, `board-phase1-cli-surface`, `board-sort` (with
    its `BoardEntry` field checks), `calendar-interop`, `events-runtime-surface`,
    `list-targeting-cli`, `parity-phase3b-cli-surface`, `recurring-completion`,
    `runtime-core-normalization`, `runtime-pwa-interop` and `sync-regressions`. They are for C12-4
    to replace with fake-session repository tests as it splits `nostrRuntime.ts` by domain.
  - `contacts.test.ts`: two raw-NDK `contact fetch`/`sync` assertions, until C12-3's
    standalone-session API gives them a seam.
- The CLI suite passes at 214/214 and `npx tsc --noEmit` is clean.
- Next: C12-3 (terminal runtime shutdown and a standalone-session API), then C12-4.

### Checkpoint — October 25, 2026 (C12-3 stage 1: terminal shutdown)

The runtime suite finishes by itself, without `--test-force-exit`. Nothing has been pushed.

- **The open handle was in NDK.** NDK 3.0.3 (the latest release) re-arms a referenced 30-second
  timer in every relay's `updateValidationRatio` and keeps no handle to it. Any process that ever
  made an NDK relay could never exit by itself, which is also why the CLI depended on a hard exit.
  - `ndkRelayTimers.ts` replaces that method once, keeping the same calculation. The timer is now
    stored on the relay, unreferenced, and stopped at shutdown.
  - It is installed before a session's first relay. Remove it when NDK fixes this; an upstream
    issue is worth filing (not done: it's an outward action for the maintainer).
- **Our own leak.** The session's 3-second connect race left its timer running; it is cleared now.
- **Terminal, idempotent shutdown.**
  - `RuntimeNostrSession.shutdown()` returns the same promise on every call.
  - Once it starts, `init`, `subscribe`, `publish`, `publishRaw`, `publishSigned` and
    `fetchEvents` fail with the named `RuntimeSessionClosedError`. Before, `init` after shutdown
    looked like a restart, while proof-of-work stayed aborted and the pools were destroyed. Every
    consumer already discards a session after shutting it down (PWA singleton, NWC sessions, the
    CLI's `disconnect`).
- **Debounced publishes finish.** `PublishCoordinator.shutdown()` sends any debounced publish
  still waiting and settles its callers' promises with the real result. It used to drop them,
  leaving the promises unsettled. Retries and outbox drains stop once closed; the outbox keeps
  anything unsent for the next session.
- **Tests.** `session-shutdown.test.ts` (3 cases) covers:
  - a child process that connects, publishes and shuts down exits by itself (with the shim
    switched off, it was still running at 8 s);
  - double shutdown, and every operation after it;
  - a debounced publish waiting at shutdown is sent.
- **Verification.**
  - Runtime 80/80, finishing naturally in about 18 s;
  - CLI 214/214;
  - PWA nostr and wallet tests 250 (12 skipped), and `tsc` is clean.
- Next: the standalone-session API for profile, contact, bot and inbox-relay reads and writes
  (stage 2).

### Checkpoint — October 25, 2026 (C12-3 stage 2: standalone sessions, multi-relay teardown)

- **Found while testing the standalone session: shutdown with several relays reconnected them.**
  - When more than half of a pool's relays drop within 5 seconds, NDK 3.0.3 takes it for a
    system sleep and reconnects them. That reopens sockets and keepalive timers after shutdown.
  - NDK also has no pool teardown: the `pool.destroy?.()` call did nothing.
  - Stage 1's exit test used one relay, so it missed this. Its three-relay variant failed first
    (the process was still running).
- **Shared teardown.** `closeNdkPools` (in `ndkLifecycle.ts`, renamed from `ndkRelayTimers.ts`)
  takes each relay out of its pool before its asynchronous disconnect arrives, so the pool never
  sees a mass drop. It also clears NDK's temporary-relay and system-event timers. Both kinds of
  session use it.
- **`StandaloneNostrSession`** (with `withStandaloneSession`, which always closes) is the owned
  path for one-off reads and writes outside a runtime session:
  - same AUTH and proof-of-work handling as the main session;
  - every returned event's signature checked;
  - bounded connect and read waits, with their timers cleared;
  - writes through `publishStandaloneEvent`, so proof-of-work refusals are re-mined;
  - a terminal, idempotent close;
  - NDK's outbox model off, since these sessions always name their relays.
- **Tests.** `standalone-session.test.ts` (6 cases) covers:
  - a forged event dropped from a read;
  - a signed write accepted, and a write without a key refused;
  - close twice, and nothing working after it;
  - a child process exiting by itself after success, an error, or a timeout.
- **Verification.**
  - Runtime 87/87, finishing naturally in about 18 s;
  - CLI 214/214;
  - PWA nostr and wallet tests 250 (12 skipped), and `tsc` is clean.
- Next: move the CLI's profile, contact, bot and inbox-relay helpers onto `withStandaloneSession`
  (stage 3).

### Checkpoint — October 25, 2026 (C12-3 stage 3 — complete)

C12-3 is complete. Nothing has been pushed.

- **CLI on the standalone session.** Profile read and publish, contact fetch and sync, bot command
  list publish and show, and inbox-relay lookup all run through `withStandaloneSession`. It is
  injectable as `CliDependencies.withStandaloneSession`. No CLI code builds a raw NDK instance any
  more.
  - Before, these helpers never closed their relays.
  - `publishProfile` opened a second connection to read the current profile; it now reads and
    writes in one session.
  - `contact fetch` started a whole runtime just to disconnect it; that is gone.
  - The CLI's own `verifiedRawEvents` is removed; the runtime's does the same check.
- **Tests.** `standalone-commands.test.ts` (5 cases) covers:
  - `contact fetch`: an anonymous read and the saved contact, and a failure that saves nothing
    but still closes the session;
  - `contact sync`: the encrypted and legacy lists merged, and one encrypted list published with
    nobody's key in the clear; `--pull` doesn't publish;
  - bot command lists published to the profile's relays plus the inbox relays, then read back.
  - Every session that opens is closed.
- The last two source regexes in `contacts.test.ts` are retired. Its kind/d-tag interop value
  check remains.
- **Verification:**
  - CLI 218/218, `npx tsc --noEmit` clean;
  - runtime 87/87, finishing naturally.
- **Not done:** the CLI executable still ends with its one hard exit (C12-1). Now that sessions
  close completely, a later step could make it optional, but nothing here depends on that.
- Next: C12-4 (split the CLI Nostr adapter by domain, replacing the remaining runtime source
  regexes with fake-session repository tests).

### Checkpoint — October 25, 2026 (C12-4 step 1: the runtime seam and task characterization)

Nothing moved yet. Behaviour is pinned first, as the proposal requires.

- **The seam.** `createNostrRuntime(config, dependencies)` takes:
  - the session factory;
  - the task cache store and `saveConfig`;
  - a clock (milliseconds) and a UUID source.

  Production defaults are the existing file-backed session, cache, config and system clock. The
  recurring-occurrence helper now gets the runtime's clock too.
- **The harness.** `dist/runtime.js` is a new bundle entry for tests. `tests/helpers/runtimeHarness.ts`
  runs the real `RuntimeNostrSession` against the runtime package's loopback relay, with in-memory
  stores, a clock the test moves, and sequential UUIDs. This tests real signing, board encryption
  and tags rather than a fake's version of them. The loopback relay now honours `since`/`until`,
  as relays do.
- **`runtime-tasks.test.ts` (9 cases)** pins the task behaviour before it moves:
  - board-signed events with their exact tags and decrypted payload;
  - a list board's default first list;
  - status and list filters, and the cache cursor;
  - compound boards aggregating their children;
  - updates, including a same-second edit getting `created_at + 1`;
  - recurring completion publishing its next occurrence exactly once;
  - deletion;
  - id prefixes, subtasks and assignment responses;
  - clear-completed.
- It replaces the last runtime regex in `recurring-completion.test.ts`, as the stage-3 handoff
  asked.
- CLI 226/226, `npx tsc --noEmit` clean; runtime suite still passes.

### Checkpoint — October 25, 2026 (C12-4 step 2: the task domain moves out)

The task code now lives in three modules behind the unchanged `NostrRuntime` facade. Method bodies
were moved by line range, unedited.

- **`src/runtime/context.ts`** holds what every domain shares:
  - `RuntimeContext`: config, session, connection, board relays, task cache, config saving, clock
    and UUIDs;
  - board content encryption, the user's pubkey and board lookup.
- **`src/runtime/taskCodec.ts`** has the `FullTaskRecord` types and the conversions: event to
  record, record to cache, and cache to record.
- **`src/runtime/taskRepository.ts`** has `createTaskRepository(context)`: task fetches, id
  resolution, publishing, and the ten task methods.
- **`nostrRuntime.ts`** goes from about 1,780 lines to about 920. The facade delegates its task
  methods and still exports the task types, so commands import from the same place.
- **Five more characterization cases** (14 in `runtime-tasks.test.ts`):
  - a board found by name, and a week board's `day` column;
  - task events signed by another key are ignored;
  - the cache keeps every field and deleted tasks, so a read from the cache alone matches the
    relay's;
  - another device's later version wins by relay time, not payload `createdAt`, and its deletion
    hides the task;
  - changes build on the newest version while a relay still serves an older one.

  All 14 pass against the original monolith as well. Parsing a task's time from its payload
  instead of the relay breaks two of them.
- **Regex tests retired.** These source-regex tests read task code that now lives elsewhere, and
  the cases above replace them:
  - all of `board-core-integration`, `list-targeting-cli` and `parity-phase3b-cli-surface`;
  - five task cases in `sync-regressions`;
  - the prefix case in `runtime-core-normalization`;
  - the week-column case in `runtime-pwa-interop`.

  The calendar and board regexes left in those files are narrowed to what still sits in
  `nostrRuntime.ts`. Steps 3–4 retire them.
- CLI 221/221, `npx tsc --noEmit` clean.
- Next: step 3, calendar characterization on the harness, then the calendar domain move. The
  cases to cover:
  - `createEvent` publishing the 30310 canonical copy plus the 30311 view;
  - `getEvent`/`listEvents`, `updateEvent` and `deleteEvent`;
  - invite tokens and RSVP responses.

  Step 4 does the same for boards (`createBoard`/`updateBoard` tags including sort, and
  `syncBoard` saving config).

### Checkpoint — October 25, 2026 (C12-4 step 3: the calendar domain moves out)

- **`runtime-calendar.test.ts` (11 cases)** pins the calendar behaviour on the loopback relay before
  anything moved. Payloads are decrypted with `nostr-tools`' NIP-44 directly (board key to itself,
  and the event key), so the wire format is checked independently of the CLI's crypto helpers.
  The cases:
  - the board copy (30310): exact tags, board signer, canonical payload;
  - the invitees' view (30311): its `a` address, and that it carries no event key, tokens or
    participants;
  - a list board's first list, a given list, and no column on a week board;
  - listing newest first across boards, by board name; getting by id prefix;
  - an id matching events on two boards needs `--board` for get, update and delete;
  - updates keep what they don't change, and a same-second edit gets `created_at + 1`;
  - invite tokens follow the participants under the same event key;
  - invitations return the token and both addresses, keep the token when sent twice, and refuse
    the sender;
  - deletion publishes deleted copies (column cleared) that every read leaves out;
  - an RSVP response is written onto the board copy;
  - events signed by another key are ignored;
  - changes build on the newest version while a relay still serves an older one.

  All 11 pass against the original monolith.
- **The move.** Method bodies moved by line range, unedited:
  - `src/runtime/calendarCodec.ts`: the `FullEventRecord`/`EventInvitation` types and the 30310
    decoding;
  - `src/runtime/calendarRepository.ts`: `createCalendarRepository(context)` with fetching, id
    resolution, two-copy publishing and the seven calendar methods, plus the `CreateEventInput`
    and `EventPatch` types.

  `inviteToEvent` now calls the repository's own `getEvent`/`updateEvent` rather than `this`, so it
  no longer depends on how the facade is called. `nostrRuntime.ts` is down to about 320 lines:
  the facade, boards, reminders, security config and relay status.
- **Regex tests retired:**
  - all of `calendar-interop` (14), `events-runtime-surface` (2), `runtime-core-normalization`
    and `sync-regressions`;
  - `runtime-pwa-interop`'s author check, narrowed to the board-metadata fetch for step 4.
- CLI 213/213, `npx tsc --noEmit` clean.
- **Found; needs deciding, not changed.** `applyEventRsvpResponse` (`share inbox --apply`) writes
  an attendee's RSVP onto the owner's board copy:
  - a single `rsvpStatus`/`rsvpCreatedAt`, with `lastEditedBy` set to the attendee;
  - re-signed with the board key.

  The PWA keeps `rsvpStatus` only on events the user was invited to (`external`). It is the
  attendee's own answer and is never published into the owner's copy. A later `updateEvent` from
  the CLI also drops the field. The tests pin today's behaviour so the move couldn't change it.
  Deciding the cross-client model for responses an owner receives belongs in taskify-core.
- **Fixed after the move (own commit, failing test first).** `createEvent` was the only facade
  method that used its `boardId` without resolving it. Given a board's name, it derived the
  signing key and relays from the name and returned the name as the board id. Given an unknown
  board, it published anyway. The one CLI caller resolves the board first, so this was latent.
  `createEvent` now resolves like `createTaskFull`: it refuses an unknown board and returns
  `boardName`. CLI 214/214.
- Next: step 4, board characterization (`createBoard`/`updateBoard` 30300 tags including sort,
  and `syncBoard` saving config), then the board move. That retires `board-phase1-cli-surface`,
  `board-sort`'s runtime cases and the rest of `runtime-pwa-interop`.

### Checkpoint — October 25, 2026 (C12-7: event RSVPs across clients)

C12-7 is done, before C12-4 step 4 as asked. Four commits, none pushed.

1. **Core rule with shared vectors.** `taskify-core/src/calendarRsvp.ts`:
   - `planCalendarRsvp`, `acceptCalendarRsvp` (names the reason it rejects),
     `deriveBoardRsvpToken` and `latestCalendarRsvps`;
   - `fixtures/calendar-rsvp-vectors.json` is written by the core test and checked by Swift
     `CalendarRsvpVectorTests`;
   - iOS's `SharedCalendarRSVPContract` is split into the same pure plan and accept steps, and its
     builder and decoder use them.

   Two iOS details now follow core: an unknown free/busy value is dropped instead of voiding the
   payload, and an RSVP whose address names another event is not built. Core 173/173; Swift 880
   tests, 0 failures.
2. **The PWA uses it.**
   - `planCalendarRsvpPublication` keeps its relay and signer checks and delegates the rest;
   - the organizer view accepts through `acceptCalendarRsvp`, which also checks the `a` address
     client-side now, and keeps the newest per attendee through `latestCalendarRsvps`;
   - the board-derived token comes from core.

   `tsc -b` and lint clean; 746 tests pass.
3. **CLI organizer.**
   - `listEventRsvps` reads the answers for the event's address and keeps what core accepts;
   - `event show` lists them in human and JSON output;
   - `applyEventRsvpResponse` is removed, `share inbox --apply` no longer applies the RSVP DM, and
     a stray board-copy `rsvpStatus` is not read.
4. **CLI attendee.** `event rsvp <id> <status>` publishes a kind 30312 answer:
   - it takes the address, token and relays from the newest invitation in the share inbox (id or
     prefix), or with `--board` from an event on your own board (your token, else the board's);
   - `--fb` and `--note` are new;
   - `--to` is accepted and ignored, so existing scripts keep working.

   An end-to-end case runs the real command through a real standalone session on the loopback
   relay, and the organizer's runtime reads the answer back. CLI 219/219, `npx tsc --noEmit`
   clean.

- **Not verified:**
  - against a real PWA or iOS client on live relays: the shared vectors and NIP-44 decryption
    stand in for that;
  - the PWA organizer view in a browser.
- **Pre-existing:** `npx tsc --noEmit -p tsconfig.app.json` in the PWA reports 22 errors
  (`erasableSyntaxOnly`, unused locals), the same count with and without this change. CI runs
  `tsc -b`, which is clean.
- Next: C12-4 step 4, board characterization, then the board domain move.

### Security fix — October 26, 2026: CLI board definitions published child-board ids and list names

Found while answering what is public about events and RSVPs.

- **The leak.** The CLI's board definition (kind 30300) carried two plaintext tags that the PWA
  and iOS keep only in the encrypted content:
  - `["ch", <childBoardId>]` for each child of a compound board;
  - `["col", <listId>, <listName>]` for each list of a list board.

  A board's id is its key: from it anyone derives the board's signer and can decrypt every task,
  event and definition on it. A tag is readable by anyone who queries the relay.
- **Fixed** (failing test first, `tests/runtime-boards.test.ts`). The definition's tags are now
  `d`, `b`, `k`, `name` (and the CLI's `sort`), as on the other clients. Lists and children stay
  in the encrypted payload, where every client already reads them. Definitions older clients
  published with these tags are still read.
- **Which boards to consider exposed:**
  - *Every child board of a compound board whose definition a CLI published from 2026-03-13
    (commit `2d7c05ef`) up to this fix.* The definition is republished in full on every board
    change, not only on `board create --kind compound`. That covers rename, archive and unarchive,
    hide and show, index card, share settings, sort, and adding, removing or reordering a child.
    Anyone who read one of those definitions can read everything on those child boards: tasks,
    events, attachments' metadata and invite tokens.
  - *The list names of every list board whose definition a CLI published from 2026-03-09 (commit
    `0971a639`).* That covers `board create` and every list or board change above. Only the
    names are exposed, not the board's contents; this is privacy, not access.
  - Not exposed by this: the compound board's own contents (its `b` tag is a hash), boards
    published only from the PWA or iOS, and task and event content.
- **On this machine** the CLI's only profile has no boards, so none recorded here need checking. A
  CLI elsewhere, such as an agent install, may have published boards; check that install's boards
  with the criteria above.
- **What the fix can't undo.** Publishing the definition again from a fixed CLI replaces the old
  copy on relays that keep only the newest addressable event. Relays that archive, and anyone who
  already read it, still have the old one. An exposed child board stays readable by whoever saw
  its id. Real remediation is a new board (a new id), with its tasks moved and the board shared
  again. That is the owner's call, and no client automates it today.
- CLI 222/222, `npx tsc --noEmit` clean.

### Checkpoint — October 26, 2026 (C12-4 step 4: the board domain moves out; C12-4 done)

- **Characterization first.** Four more cases in `runtime-boards.test.ts` pass against the
  pre-move code:
  - creating a board: config entry, one save, the full encrypted payload, the board's signer;
  - updating one found by name: every field, the `sort` tag with its ascending default, and
    nothing published for an unknown board;
  - syncing: the newest definition into the config, one save, other members' control characters
    removed;
  - definitions signed by another key are ignored.
- **The move.** `src/runtime/boardRepository.ts` holds `createBoardRepository(context)`:
  definition publishing, `syncBoard`, `createBoard` and `updateBoard`, with named
  `CreateBoardInput`/`BoardPatch`/`SyncedBoard` types. The bodies are unedited.
  `nostrRuntime.ts` keeps the facade, connection, local reminders, agent security config and
  relay status (176 lines).
- **Retired:**
  - `board-sort` (8), `board-phase1-cli-surface` and `runtime-pwa-interop`, the last source
    regexes over the runtime;
  - `BoardEntry.eventKeys`, which nothing used except `board-sort`'s regex.
- CLI 215/215, `npx tsc --noEmit` clean.
- **Two fixes after the move** (own commit, failing tests first):
  - *Definitions took the wall clock.* Unlike tasks and events, `publishBoardDefinition` never set
    `created_at`, so NDK stamped it at signing and the runtime's injected clock was ignored. It
    now uses the clock, as the PWA does (`nowSeconds`).
  - *A stale sort could win.* `syncBoard` took the board's other fields from the newest
    definition, but its sort from whichever fetched definition carrying a `sort` tag came last.
    A relay still serving an older copy could restore an old sort order. The sort now comes from
    the same newest definition (its tag, else its payload), and only values a client writes are
    accepted. The PWA and iOS publish no sort, so a definition from them leaves this device's sort
    as it is.

  CLI 217/217, `npx tsc --noEmit` clean.
- **Left as found, cross-client (since fixed; see "Same-second board definitions" below):** the
  PWA and CLI stamped board definitions with the current second, with no `previous + 1` as tasks
  have. Two changes to one board in the same second could therefore tie, and NIP-01 relays keep
  the lower event id. iOS was already monotonic (`nextNostrTimestamp`).

### Checkpoint — October 26, 2026 (C12-5: the CLI consumes the cross-client wire vectors)

- **The test.** `tests/wire-vectors.test.ts` makes the CLI a third consumer of
  `taskify-core/fixtures/`. Each PWA- and iOS-made task and calendar event is put on the loopback
  relay under the vector boards' shared ids and read by the CLI's own runtime:
  - the decoded id, title, note, due time, status, list, priority, recurrence, series and
    documents must match the vector;
  - every live task is then edited from the CLI, and the republished payload must keep what other
    clients wrote: `republishKeeps`, and the Scripture Memory link and stage, which the CLI doesn't
    model but must carry;
  - `compareReplaceableEvents` is checked against `event-version-vectors.json`.

  No codec seams needed exporting; the runtime is exercised as the CLI runs it.
- **Differences found, each with the shared rule already in the vectors, fixed in the CLI:**
  - *CLI edits deleted other clients' reminders.* `updateTask` stripped `reminders` from the
    payload it republished, on the grounds that reminders are device-local. They are local in the
    CLI, but the PWA and iOS sync them in the payload, so a CLI edit wiped a task's reminders on
    every other device. The payload's reminders are now kept as received, and the CLI still never
    publishes its own.
  - *Version ids compared case-sensitively.* The CLI's comparator now delegates to core
    `compareEventVersions`: ids in any case, and a known id beats an unknown one.
- The calendar vectors already matched.
- The vector descriptions (and their PWA/Swift/core generators) now name the CLI as a consumer.
- CLI 222/222; core 173/173; the PWA and Swift vector suites pass.

### Same-second board definitions — October 26, 2026

- **The defect.** The PWA (`nowSeconds()`) and the CLI stamped a board definition (kind 30300,
  replaceable) with the current second only. Two changes to one board in the same second, or
  after another member whose clock is ahead, got a `created_at` no later than the version before.
  NIP-01 relays then keep one by id, so a real change could be silently dropped. Tasks were already
  safe on every client (`max(now, previous + 1)`). iOS's `nextNostrTimestamp` was already
  app-wide monotonic, and is raised by every event it receives.
- **The shared rule.** One function for a new version's `created_at`, `nextEventCreatedAt(now,
  previous?)` in `taskify-core/src/eventVersion.ts`. Its vectors are in the new `nextCreatedAt`
  section of `event-version-vectors.json`, checked by core and by Swift `EventVersionVectorTests`
  (`EventVersion.nextCreatedAt`). The three copies of this rule now use it:
  - the PWA's task ledger (`reserveTaskMutationTimestamp` removed);
  - the CLI's task and calendar publishing;
  - iOS's `nextNostrTimestamp`.
- **Board definitions, failing tests first:**
  - *PWA:* `BoardSyncLedger.reserveBoardMeta` stamps each definition after the newest one the
    ledger has seen or sent.
  - *CLI:* a board's config entry keeps `definitionAt`, the newest definition this device
    published or read in `syncBoard`. It is saved with the config, so the next command, a new
    process, still knows it.
- **Verified:**
  - CLI 223/223; PWA `tsc -b` and lint clean, 747 tests; core 173/173; Swift
    `EventVersionVectorTests` 2/2;
  - the iOS app target, which `swift test` doesn't compile, built for the simulator with the
    `AppModel` change.
- **Still possible:** two devices changing one board in the same second, neither having seen the
  other's change. No client can order that without coordination; relays keep one, as with any
  replaceable event.
