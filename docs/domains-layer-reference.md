# Taskify Domains Layer Reference

Purpose: map `taskify-pwa/src/domains/` by responsibility, key functions, persistence impact, and where each domain is called from in the app.

This complements:
- `docs/architecture-overview.md` (system-level architecture)
- `docs/functions-and-flows.md` (end-to-end flows)

---

## 1) Domain Map (current repo)

`taskify-pwa/src/domains/` currently contains:

- `appTypes.ts`
- `storageKeys.ts`
- `tasks/`
- `calendar/`
- `dateTime/`
- `nostr/`
- `backup/`
- `push/`
- `print/`
- `scripture/`

---

## 2) Cross-cutting foundations

### `domains/appTypes.ts`
Shared app-level TypeScript types used across feature domains.

Typical usage:
- Shared discriminated unions for view/state transitions
- Common DTO-like shapes between hooks and UI components

### `domains/storageKeys.ts`
Canonical local storage key constants used by onboarding/session/settings flows.

Why it matters:
- Prevents stringly-typed key drift
- Defines onboarding completion flags and related persistence contracts

---

## 3) Tasks domain (`domains/tasks/`)

### Files
- `taskTypes.ts`
- `taskUtils.ts`
- `taskHooks.ts`
- `boardUtils.ts`
- `settingsTypes.ts`
- `settingsHook.ts`
- `contactUtils.ts`

### Responsibilities
- Core task and board type system
- Task create/update/list/filter/sort helpers
- Board shape parsing (`week`, `lists`, `compound`, `bible`)
- Settings read/write contract for task-related UX behavior
- Contact metadata shaping used in assignment/editor context

### Data touched
- In-memory React state (primary)
- IndexedDB via storage abstractions (task/board persistence)
- Nostr event serialization input (shared boards / sync)

### Key integration points
- `App.tsx` task reducers/handlers
- Agent runtime (`src/agent/agentRuntime.ts`) for task CRUD operations
- Nostr publish/subscribe path via `src/nostr/*`

---

## 4) Calendar domain (`domains/calendar/`)

### Files
- `calendarHook.ts`
- `calendarUtils.ts`
- `holidayUtils.ts`

### Responsibilities
- Upcoming/calendar projection from task set
- Date-bucket grouping and calendar grid derivation
- Holiday-aware rendering metadata (where enabled)

### Data touched
- Derived view state from task due dates
- No independent persistence layer (read-only derivation)

### Key integration points
- Upcoming page rendering and date navigation UI
- Reminder planning UX where due-date semantics matter

---

## 5) Date/time domain (`domains/dateTime/`)

### Files
- `calendarPickerHook.tsx`
- `dateUtils.ts`
- `reminderUtils.ts`
- `timezoneUtils.ts`

### Responsibilities
- Date parsing/normalization for UI and persistence
- Reminder offset computations
- Timezone normalization and formatting consistency
- Calendar picker interaction state

### Data touched
- Derived timestamps (ISO / epoch transforms)
- Reminder schedule payload inputs

### Key integration points
- Task due-date editor
- Reminder scheduling API payloads (`PUT /api/reminders`)
- Calendar/Upcoming rendering logic

---

## 6) Nostr helpers domain (`domains/nostr/`)

### Files
- `nostrCrypto.ts`
- `nostrKeyUtils.ts`
- `nostrPool.ts`

### Responsibilities
- Key encoding/decoding helpers
- Lightweight cryptographic helper wrappers
- Pool/session helper utilities used by app-level Nostr code

### Data touched
- Nostr key material transforms (hex/bech32)
- Event signing/publish helper inputs

### Key integration points
- Session initialization and key validation paths
- Onboarding/import flows that handle nsec/npub conversion

---

## 7) Backup domain (`domains/backup/`)

### Files
- `backupTypes.ts`
- `backupUtils.ts`

### Responsibilities
- Backup payload typing and schema safety
- Backup serialization/deserialization helpers
- Manual file backup serialization and restore helpers

### Data touched
- Local file payloads used to restore task/app state

### Key integration points
- Settings backup/restore actions
- Encrypted Nostr backup synchronization is handled separately by `useNostrAppBackupSync`

---

## 8) Push domain (`domains/push/`)

### File
- `pushUtils.ts`

### Responsibilities
- Build reminder snapshot payloads
- Normalize reminder offsets and device subscription metadata
- Coordinate PWA-side reminder sync requests

### Data touched
- Reminder payload sent to Worker `PUT /api/reminders`
- Local device subscription metadata used for polling

### Key integration points
- Task edit modal reminder controls
- Service worker wake/poll lifecycle
- Worker cron-delivery pipeline (documented in `docs/worker-backend.md`)

---

## 9) Print domain (`domains/print/`)

### File
- `printUtils.ts`

### Responsibilities
- Prepare printable task/board representations
- Consistent print layout shaping from current task state

### Data touched
- Read-only derived content from active tasks/boards

### Key integration points
- Print/export UI actions

---

## 10) Scripture domain (`domains/scripture/`)

### Files
- `scriptureHook.ts`
- `scriptureTypes.ts`
- `scriptureUtils.ts`

### Responsibilities
- Bible tracker data types and helper logic
- Progress/state derivation for scripture reading features
- Hook-level orchestration for scripture UI state

### Data touched
- Local scripture progress state (through app persistence abstractions)

### Key integration points
- Bible Tracker component(s)
- Daily routine/overview surfaces that include scripture progress

---

## 11) Domain boundaries and edit guidance

Use this quick rule set before editing:

1. **If it changes task semantics** (status, recurrence, board, sorting), start in `domains/tasks/`.
2. **If it changes date math** (timezone, reminders, due-date conversion), start in `domains/dateTime/`.
3. **If it changes reminder API payloads**, start in `domains/push/pushUtils.ts` and validate against Worker docs.
4. **If it changes key/encoding behavior**, start in `domains/nostr/` and verify upstream `src/nostr/*` usage.
5. **If it changes backup format**, update both `domains/backup/*` and Worker backup docs together.

---

## 12) Documentation maintenance checklist (domains)

When changing any domain file:

- Update this file (`docs/domains-layer-reference.md`) if responsibilities or file map changed.
- Update `docs/functions-and-flows.md` if runtime flow order changed.
- Update `docs/architecture-overview.md` if system boundaries changed.
- If new persistence keys are introduced, update `domains/storageKeys.ts` references in docs.

This keeps domain docs synchronized with architecture and flow docs.
