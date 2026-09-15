# Taskify Shared Architecture Boundaries

## Goal
Minimize drift across CLI and PWA by centralizing shared behavior, while keeping platform-specific concerns local.

## Package boundaries

### `taskify-core` (pure domain)
Use for platform-agnostic business/domain logic only:
- contracts and payload normalization
- calendar/task/share/contact/backup domain rules
- pure parsing/validation helpers
- pure crypto primitives and deterministic transforms

Must not own:
- network/session lifecycle
- relay orchestration/backoff/auth hooks
- app storage adapters
- UI/CLI rendering and command routing

### `taskify-runtime-nostr` (shared transport runtime)
Use for Nostr runtime orchestration shared by multiple apps:
- board key derivation manager
- relay URL normalization
- session/publisher/subscription orchestration extracted from PWA
- relay auth/health/info cache and runtime composition primitives

Must not own:
- PWA-only UX/state wiring
- CLI-only command/config/cache UX

### App packages (`taskify-pwa`, `taskify-cli`)
Keep platform-specific wiring:
- UX, rendering, commands
- local storage/profile formats
- startup composition and feature toggles

## Extraction policy
1. Prefer extracting from PWA source-of-truth for runtime modules.
2. Extract in slices with tests first.
3. Wire PWA first, then CLI.
4. Keep behavior identical during migration.

## Entry-point composition

`taskify-pwa/src/App.tsx` composes board state and callbacks. The reusable board
column UI lives in `taskify-pwa/src/ui/board/DroppableColumn.tsx`, which owns drag
feedback, drop positioning, selection controls, and its DOM event subscriptions.
It receives callbacks and children through props and does not import `App`.

`taskify-cli/src/index.ts` creates the Commander program, installs global options,
registers each command group, and handles final parsing and errors. All command
actions live in `taskify-cli/src/commands/`, grouped by feature: discovery, boards,
events, sharing, task queries/mutations, attachments, agent helpers, transfer,
backup, inbox, assignments, setup, and the smaller administration groups.

`commands/context.ts` creates the shared command helpers once per program. Each
registration declares the subset it consumes with `Pick<CommandContext, ...>`.
Helpers preserve existing identity validation, reference resolution, document
loading, and structured error handling. They read global options at action time.
Command modules do not import or execute the entry point. Board creation is
registered separately on the same board command to preserve its help ordering.

Continue extracting cohesive UI components and command groups in small slices;
keep domain logic in shared core/runtime packages and avoid changing behavior
while moving code.

Saved board-print job loading, normalization, and persistence live in
`taskify-pwa/src/storage/boardPrintJobs.ts`. The storage key and recovery behavior
remain compatible with existing saved jobs; `App.tsx` only creates jobs and calls
the storage module. Storage access continues through `kvStorage`.

Appearance effects are grouped in `taskify-pwa/src/theme/useAppAppearance.ts`.
The hook accepts only appearance settings and applies font size, dark mode,
status-bar color, accent variables, and background images. It owns background
object-URL cleanup on dependency changes and unmount; the entry point calls it
at the original effect location to preserve ordering.

Configuration commands are registered in `taskify-cli/src/commands/config.ts`.
The shared WebSocket connection probe lives in `src/relayDiagnostics.ts` and is
passed to both relay and config registration. This keeps connection diagnostics
out of the entry point while preserving existing timeout and output behavior.

Profile commands and their interactive prompt queue live in
`taskify-cli/src/commands/profile.ts`. This module owns command presentation;
profile persistence and metadata publication still use their existing services.
CSV serialization/parsing for CLI import/export lives in `taskify-cli/src/csv.ts`.
The extraction preserves the existing parser semantics.

PWA push-key decoding lives in `domains/push/vapidKey.ts`; the generic promise
race/deadline helper lives in `lib/withTimeout.ts`. A deadline rejects the caller's
wait and clears its timer; it does not cancel the underlying operation.

The PWA's reminder HTTP request is isolated in `domains/push/reminderClient.ts`.
It owns stable payload ordering, reminder-minute serialization, request timeout,
and HTTP error propagation. App state still decides when a sync is required and
owns the abort controller.

## Remaining stateful composition

The PWA entry point still coordinates task/calendar recurrence, relay event
reconciliation, printing, and view composition. Further decomposition should be
feature-specific work with state-transition and UI coverage; moving those closures
behind a large bag of mutable state would not establish a useful boundary. This
organization pass leaves that orchestration intact.
