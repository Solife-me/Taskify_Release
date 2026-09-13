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
registers commands, and handles final parsing and errors. Bot, contact, trust, relay, cache, and completion command groups live in
`taskify-cli/src/commands/`.
Registration receives the root program so actions read global options at execution
time. Contact and relay registration also receive the existing runtime initializer to
retain its error handling. Relay registration receives the connection-check helper
shared with config diagnostics. Command modules do not import or execute the entry point.

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
